/**
 * WebSocket Gateway for Real-time Transcription
 * Proxies OpenAI Realtime API connection
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RealtimeTranscriptionService } from '../../services/transcription/realtime-transcription.service';
import {
  TranscriptionService,
  SubtitleData,
} from '../../services/transcription/transcription.service';
import { forwardRef, Inject } from '@nestjs/common';
import { TranscriptionGateway } from './transcription.gateway';

interface AuthenticatedSocket extends Socket {
  user?: {
    _id: string;
    email: string;
    systemRole?: string;
  };
}

@WebSocketGateway({
  cors: {
    origin: [
      'https://live.hrdeedu.co.kr',
      'https://api.hrdeedu.co.kr',
      'http://localhost:3088',
      'http://localhost:3001',
    ],
    credentials: true,
  },
  namespace: '/realtime-transcription',
})
export class RealtimeTranscriptionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeTranscriptionGateway.name);
  private openaiConnections = new Map<string, any>(); // socketId -> OpenAI WebSocket
  private sessionReady = new Map<string, boolean>(); // socketId -> session ready state
  private clientLanguages = new Map<string, string>(); // socketId -> current target language

  constructor(
    private realtimeService: RealtimeTranscriptionService,
    private jwtService: JwtService,
    @Inject(forwardRef(() => TranscriptionGateway))
    private transcriptionGateway: TranscriptionGateway,
    private transcriptionService: TranscriptionService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Verify JWT token
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      (client as any).user = payload;

      this.logger.log(
        `Client ${client.id} connected for real-time transcription`,
      );
    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    // Cleanup OpenAI connection
    const openaiWs = this.openaiConnections.get(client.id);
    if (openaiWs) {
      openaiWs.close();
      this.openaiConnections.delete(client.id);
    }

    // Cleanup session state
    this.sessionReady.delete(client.id);
    this.clientLanguages.delete(client.id);

    this.logger.log(
      `Client ${client.id} disconnected from real-time transcription`,
    );
  }

  /**
   * Start real-time transcription
   */
  @SubscribeMessage('START_REALTIME_TRANSCRIPTION')
  async handleStartTranscription(
    @MessageBody() data: { meetingId: string; language?: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.logger.log(`[RealtimeGateway] 📥 Received START_REALTIME_TRANSCRIPTION from client ${client.id}`, {
      meetingId: data?.meetingId,
      language: data?.language,
    });
    
    try {
      const { meetingId, language } = data;
      const user = (client as any).user;

      if (!meetingId) {
        client.emit('ERROR', { message: 'Meeting ID is required' });
        return;
      }

      // Initialize session ready state
      this.sessionReady.set(client.id, false);
      const initialLanguage = language || 'en';
      this.clientLanguages.set(client.id, initialLanguage);

      let connectionError: Error | null = null;

      // Create OpenAI Realtime API connection
      let openaiWs: any;

      // Track time since last final result to handle long continuous speech
      let lastFinalResultTime = Date.now();
      let lastPartialText = '';
      const FORCE_FINAL_INTERVAL = 60000; // 60 seconds - force final result if no pause detected
      let partialResultTimer: NodeJS.Timeout | null = null;

      // Clear any existing timer
      const clearPartialTimer = () => {
        if (partialResultTimer) {
          clearTimeout(partialResultTimer);
          partialResultTimer = null;
        }
      };

      try {
        openaiWs = this.realtimeService.createProxyConnection({
          language: initialLanguage,
          onPartialResult: (text: string) => {
            // Forward partial result to client
            const currentLanguage =
              this.clientLanguages.get(client.id) || initialLanguage;
            this.logger.debug(`[RealtimeGateway] Partial result: ${text}`);
            client.emit('PARTIAL_TRANSCRIPTION', {
              text,
              language: currentLanguage,
            });

            // Store last partial text for forced finalization
            lastPartialText = text;
            lastFinalResultTime = Date.now();

            // Clear existing timer and set new one
            clearPartialTimer();

            // Monitor for long continuous speech without pauses
            // OpenAI Realtime API will automatically chunk long speeches, but we track this for logging
            const timeSinceLastFinal = Date.now() - lastFinalResultTime;
            if (timeSinceLastFinal >= FORCE_FINAL_INTERVAL) {
              this.logger.warn(
                `[RealtimeGateway] ⏰ Long continuous speech detected: ${Math.round(timeSinceLastFinal / 1000)}s without final result. OpenAI API should auto-chunk soon.`,
              );
            }
          },
          onFinalResult: async (text: string, detectedLanguage: string) => {
            try {
              // Update last final result time
              lastFinalResultTime = Date.now();
              clearPartialTimer();
              lastPartialText = ''; // Clear stored partial text

              this.logger.log(
                `[RealtimeGateway] Final result received: ${text} (detected: ${detectedLanguage})`,
              );

              // Accept any detected language - OpenAI can translate from any language
              const normalizedLang = detectedLanguage?.toLowerCase() || 'en';

              // Validate transcription quality - reject hallucinations and unclear transcriptions
              if (
                !this.transcriptionService.validateTranscriptionQuality(text)
              ) {
                this.logger.warn(
                  `[RealtimeGateway] ⚠️ Rejected low-quality transcription: "${text}"`,
                );
                return; // Don't process or broadcast low-quality transcriptions
              }

              const participantId = user?._id || 'unknown';
              const participantName = user?.displayName || 'Unknown';
              let normalizedSource = (
                detectedLanguage?.toLowerCase() || 'en'
              ).trim();

              // STRICT: Only process English or Korean
              // Map common language codes to en/ko
              if (
                normalizedSource === 'english' ||
                normalizedSource === 'eng'
              ) {
                normalizedSource = 'en';
              } else if (
                normalizedSource === 'korean' ||
                normalizedSource === 'kor'
              ) {
                normalizedSource = 'ko';
              }

              // If source is not English or Korean, ignore it
              if (normalizedSource !== 'en' && normalizedSource !== 'ko') {
                this.logger.warn(
                  `[RealtimeGateway] Ignoring non-English/Korean language: ${normalizedSource}`,
                );
                return; // Don't process or broadcast
              }

              // IMPORTANT: Don't translate here! Pass original text to broadcastSubtitle
              // broadcastSubtitle will translate to each user's preferred language individually
              // This ensures Admin gets Korean, Rakhmatillo gets English, etc.
              const subtitleData = this.transcriptionService.formatSubtitleData(
                participantId,
                text, // Original text
                text, // Use original as placeholder - broadcastSubtitle will translate per user
                normalizedSource,
                normalizedSource, // Placeholder - actual target language determined per user in broadcastSubtitle
                meetingId,
              );

              // Broadcast via TranscriptionGateway - it will translate to each user's preferred language
              // Don't await - let it run in background for speed
              this.transcriptionGateway
                .broadcastSubtitle(meetingId, {
                  ...subtitleData,
                  participantName,
                } as any)
                .catch((error) => {
                  this.logger.error(
                    `[RealtimeGateway] ❌ BROADCAST FAILED SILENTLY: ${error.message}`,
                    error.stack,
                  );
                  // Notify the speaker that broadcast failed
                  client.emit('TRANSLATION_ERROR', {
                    message: `Failed to broadcast translation: ${error.message}`,
                    originalText: text.substring(0, 100),
                    timestamp: Date.now(),
                  });
                });

              // Send to the speaking client with their preferred language for immediate feedback
              // STRICT: Only English and Korean supported
              let speakerTargetLanguage = (
                this.clientLanguages.get(client.id) ||
                initialLanguage ||
                'en'
              )
                .toLowerCase()
                .trim();

              // Map variations to standard codes
              if (
                speakerTargetLanguage === 'english' ||
                speakerTargetLanguage === 'eng'
              )
                speakerTargetLanguage = 'en';
              if (
                speakerTargetLanguage === 'korean' ||
                speakerTargetLanguage === 'kor'
              )
                speakerTargetLanguage = 'ko';

              // Validate - only accept 'en' or 'ko'
              if (
                speakerTargetLanguage !== 'en' &&
                speakerTargetLanguage !== 'ko'
              ) {
                this.logger.warn(
                  `[RealtimeGateway] Invalid speaker target language: ${speakerTargetLanguage}, defaulting to 'en'`,
                );
                speakerTargetLanguage = 'en';
              }

              // STRICT LOGIC: Only translate if source and target are different AND both are en/ko
              // If speaker's language matches source, don't show translation (they understand already)
              if (
                normalizedSource !== speakerTargetLanguage &&
                (normalizedSource === 'en' || normalizedSource === 'ko') &&
                (speakerTargetLanguage === 'en' ||
                  speakerTargetLanguage === 'ko')
              ) {
                // Different languages - translate for speaker
                this.transcriptionService
                  .translateText(text, speakerTargetLanguage, normalizedSource)
                  .then((translation) => {
                    if (
                      translation.translatedText &&
                      translation.translatedText.trim().length > 0
                    ) {
                      client.emit('FINAL_TRANSCRIPTION', {
                        text,
                        translatedText: translation.translatedText.trim(),
                        language: normalizedSource,
                        targetLanguage: speakerTargetLanguage,
                        participantId,
                        participantName,
                      });
                    }
                    // If translation is empty, don't send anything (ignore)
                  })
                  .catch((error) => {
                    // Translation failed - don't send anything (ignore instead of showing wrong text)
                    this.logger.warn(
                      `[RealtimeGateway] Translation failed for speaker feedback: ${error.message}`,
                    );
                  });
              } else {
                // Same language or invalid language - don't send translation (speaker already understands)
                // Only send if user explicitly wants to see their own language
                // For now, skip FINAL_TRANSCRIPTION to avoid confusion
              }

              this.logger.log(
                `[RealtimeGateway] ✅ Broadcasted original text (translation handled per-user): ${text}`,
              );
            } catch (error: any) {
              this.logger.error(
                `[RealtimeGateway] Translation error: ${error.message}`,
              );
              // Don't send anything if there's an error - better to show nothing than wrong text
            }
          },
          onError: (error: Error) => {
            connectionError = error;
            this.logger.error(
              `[RealtimeGateway] OpenAI connection error: ${error.message}`,
            );
            client.emit('ERROR', { message: error.message });
          },
        });
      } catch (error: any) {
        this.logger.error(
          `[RealtimeGateway] Failed to create OpenAI connection:`,
          {
            message: error.message,
            stack: error.stack,
          },
        );
        client.emit('ERROR', {
          message: `Failed to create OpenAI connection: ${error.message || 'Unknown error'}`,
        });
        return;
      }

      if (!openaiWs) {
        this.logger.error('[RealtimeGateway] OpenAI WebSocket is null');
        client.emit('ERROR', {
          message: 'Failed to create WebSocket connection',
        });
        return;
      }

      // Store connection
      this.openaiConnections.set(client.id, openaiWs);

      // Forward messages from OpenAI to client and track session state
      openaiWs.on('message', (messageData: Buffer | string) => {
        try {
          const message = JSON.parse(messageData.toString());

          // Check if session is ready
          if (
            message.type === 'session.updated' ||
            message.type === 'session.created'
          ) {
            this.sessionReady.set(client.id, true);
            this.logger.log(
              `[RealtimeGateway] ✅ Session ready for client ${client.id}`,
            );
            
            // Note: TRANSCRIPTION_STARTED is now sent in waitForSession() below
            // This ensures proper sequencing
          }

          // Forward all messages to client for debugging
          client.emit('REALTIME_MESSAGE', message);
        } catch (error) {
          this.logger.error('Failed to forward message:', error);
        }
      });

      // Forward messages from client to OpenAI (only after session is ready)
      let audioChunkCount = 0;
      client.on('AUDIO_CHUNK', (data: { audio: string }) => {
        const isReady =
          this.sessionReady.get(client.id) && openaiWs.readyState === 1;

        if (!isReady) {
          if (audioChunkCount === 0) {
            this.logger.debug(
              `[RealtimeGateway] Waiting for session to be ready. State: ${openaiWs.readyState}, Ready: ${this.sessionReady.get(client.id)}`,
            );
          }
          return; // Wait for session to be ready
        }

        try {
          openaiWs.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.audio,
            }),
          );
          audioChunkCount++;
          if (audioChunkCount % 50 === 0) {
            this.logger.debug(
              `[RealtimeGateway] Forwarded ${audioChunkCount} audio chunks to OpenAI`,
            );
          }
        } catch (error: any) {
          this.logger.error(
            `[RealtimeGateway] Failed to send audio chunk: ${error.message}`,
          );
        }
      });

      // Wait for session to be ready before emitting TRANSCRIPTION_STARTED
      // This ensures OpenAI connection is fully established
      const maxWaitTime = 5000; // 5 seconds max wait
      const checkInterval = 100; // Check every 100ms
      let waited = 0;
      
      const waitForSession = () => {
        return new Promise<void>((resolve, reject) => {
          const checkSession = () => {
            if (this.sessionReady.get(client.id) && openaiWs?.readyState === 1) {
              this.logger.log(`[RealtimeGateway] ✅ Session ready, emitting TRANSCRIPTION_STARTED for client ${client.id}`);
              client.emit('TRANSCRIPTION_STARTED', { meetingId });
              resolve();
            } else if (waited >= maxWaitTime) {
              const errorMsg = 'Timeout: OpenAI session did not become ready within 5 seconds';
              this.logger.error(`[RealtimeGateway] ❌ ${errorMsg}`);
              client.emit('ERROR', { message: errorMsg });
              reject(new Error(errorMsg));
            } else {
              waited += checkInterval;
              setTimeout(checkSession, checkInterval);
            }
          };
          checkSession();
        });
      };
      
      // Wait for session to be ready (with timeout)
      await waitForSession().catch((error) => {
        this.logger.error(`[RealtimeGateway] ❌ Failed to wait for session: ${error.message}`);
        // Error already emitted to client
      });
    } catch (error: any) {
      this.logger.error(`[RealtimeGateway] ❌ Start transcription error:`, {
        message: error.message,
        stack: error.stack,
        name: error.name,
        clientId: client.id,
        meetingId: data?.meetingId,
      });
      client.emit('ERROR', {
        message: `Failed to start transcription: ${error.message || 'Unknown error'}`,
      });
    }
  }

  /**
   * Update transcription language
   */
  @SubscribeMessage('UPDATE_TRANSCRIPTION_LANGUAGE')
  handleUpdateLanguage(
    @MessageBody() data: { language: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      const { language } = data;
      const openaiWs = this.openaiConnections.get(client.id);

      if (!openaiWs) {
        this.logger.warn(
          `[RealtimeGateway] Cannot update language - No connection for client ${client.id}`,
        );
        client.emit('ERROR', { message: 'Transcription not started' });
        return;
      }

      if (openaiWs.readyState !== 1) {
        this.logger.warn(
          `[RealtimeGateway] Cannot update language - WebSocket not ready (state: ${openaiWs.readyState}) for client ${client.id}`,
        );
        client.emit('ERROR', { message: 'WebSocket connection not ready' });
        return;
      }

      if (!language) {
        client.emit('ERROR', { message: 'Language is required' });
        return;
      }

      const oldLanguage = this.clientLanguages.get(client.id) || 'en';
      if (oldLanguage === language) {
        this.logger.debug(
          `[RealtimeGateway] Language already set to ${language}, skipping update`,
        );
        return;
      }

      this.logger.log(
        `[RealtimeGateway] 🔄 Updating transcription language from ${oldLanguage} to ${language} for client ${client.id}`,
      );

      // Update stored language for this client
      // Note: OpenAI Realtime API doesn't support updating language mid-session
      // We'll just update our internal state so translations use the new language
      // The transcription will continue with the original language, but translations will use the new one
      this.clientLanguages.set(client.id, language);

      this.logger.log(
        `[RealtimeGateway] ✅ Language updated to ${language} (will be used for future translations)`,
      );

      // Don't send session.update - OpenAI doesn't support partial updates and it causes connection to close
      // The transcription will continue with the original language, but all translations will use the new language
    } catch (error: any) {
      this.logger.error(
        `[RealtimeGateway] Failed to update language: ${error.message}`,
      );
      client.emit('ERROR', {
        message: `Failed to update language: ${error.message}`,
      });
    }
  }

  /**
   * Stop real-time transcription
   */
  @SubscribeMessage('STOP_REALTIME_TRANSCRIPTION')
  handleStopTranscription(@ConnectedSocket() client: AuthenticatedSocket) {
    const openaiWs = this.openaiConnections.get(client.id);
    if (openaiWs) {
      openaiWs.close();
      this.openaiConnections.delete(client.id);
    }
    this.sessionReady.delete(client.id);
    client.emit('TRANSCRIPTION_STOPPED');
  }
}

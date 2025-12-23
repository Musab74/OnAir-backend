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
import { TranscriptionService, SubtitleData } from '../../services/transcription/transcription.service';
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
      const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');
      
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      (client as any).user = payload;

      this.logger.log(`Client ${client.id} connected for real-time transcription`);
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

    this.logger.log(`Client ${client.id} disconnected from real-time transcription`);
  }

  /**
   * Start real-time transcription
   */
  @SubscribeMessage('START_REALTIME_TRANSCRIPTION')
  async handleStartTranscription(
    @MessageBody() data: { meetingId: string; language?: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
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
      try {
        openaiWs = this.realtimeService.createProxyConnection({
          language: initialLanguage,
          onPartialResult: (text: string) => {
            // Forward partial result to client
            const currentLanguage = this.clientLanguages.get(client.id) || initialLanguage;
            this.logger.debug(`[RealtimeGateway] Partial result: ${text}`);
            client.emit('PARTIAL_TRANSCRIPTION', { text, language: currentLanguage });
          },
          onFinalResult: async (text: string, detectedLanguage: string) => {
            try {
              this.logger.log(`[RealtimeGateway] Final result received: ${text} (detected: ${detectedLanguage})`);
              
              // Accept any detected language - OpenAI can translate from any language
              const normalizedLang = detectedLanguage?.toLowerCase() || 'en';
              
              // Validate transcription quality - reject hallucinations and unclear transcriptions
              if (!this.transcriptionService.validateTranscriptionQuality(text)) {
                this.logger.warn(`[RealtimeGateway] ⚠️ Rejected low-quality transcription: "${text}"`);
                return; // Don't process or broadcast low-quality transcriptions
              }

              // Get current language (may have been updated)
              const targetLanguage = this.clientLanguages.get(client.id) || initialLanguage;
              
              const participantId = user?._id || 'unknown';
              const participantName = user?.displayName || 'Unknown';

              // If source and target are the same, skip translation for speed
              const normalizedSource = detectedLanguage?.toLowerCase() || 'en';
              const normalizedTarget = targetLanguage?.toLowerCase() || 'en';
              
              if (normalizedSource === normalizedTarget) {
                // Same language - no translation needed, broadcast immediately
                const subtitleData = this.transcriptionService.formatSubtitleData(
                  participantId,
                  text,
                  text, // Use original as translated
                  detectedLanguage,
                  targetLanguage,
                  meetingId,
                );

                this.transcriptionGateway.broadcastSubtitle(meetingId, {
                  ...subtitleData,
                  participantName,
                } as any);

                client.emit('FINAL_TRANSCRIPTION', { 
                  text, 
                  translatedText: text,
                  language: detectedLanguage,
                  targetLanguage,
                  participantId,
                  participantName,
                });

                this.logger.log(`[RealtimeGateway] ✅ Broadcasted (no translation needed): ${text}`);
                return;
              }

              // Fast translation - optimized model and settings for speed
              const translation = await this.transcriptionService.translateText(
                text,
                targetLanguage,
                detectedLanguage,
              );

              // Validate translated text quality
              if (!this.transcriptionService.validateTranscriptionQuality(translation.translatedText)) {
                this.logger.warn(`[RealtimeGateway] ⚠️ Rejected low-quality translation: "${translation.translatedText}"`);
                return;
              }

              // Format subtitle data
              const subtitleData = this.transcriptionService.formatSubtitleData(
                participantId,
                text,
                translation.translatedText,
                detectedLanguage,
                targetLanguage,
                meetingId,
              );

              // Broadcast via TranscriptionGateway
              this.transcriptionGateway.broadcastSubtitle(meetingId, {
                ...subtitleData,
                participantName,
              } as any);

              // Also send to client
              client.emit('FINAL_TRANSCRIPTION', { 
                text, 
                translatedText: translation.translatedText,
                language: detectedLanguage,
                targetLanguage,
                participantId,
                participantName,
              });

              this.logger.log(`[RealtimeGateway] ✅ Broadcasted translation: ${translation.translatedText}`);
            } catch (error: any) {
              this.logger.error(`[RealtimeGateway] Translation error: ${error.message}`);
              // Don't send anything if there's an error - better to show nothing than wrong text
            }
          },
          onError: (error: Error) => {
            connectionError = error;
            this.logger.error(`[RealtimeGateway] OpenAI connection error: ${error.message}`);
            client.emit('ERROR', { message: error.message });
          },
        });
      } catch (error: any) {
        this.logger.error(`[RealtimeGateway] Failed to create OpenAI connection:`, {
          message: error.message,
          stack: error.stack,
        });
        client.emit('ERROR', { 
          message: `Failed to create OpenAI connection: ${error.message || 'Unknown error'}` 
        });
        return;
      }

      if (!openaiWs) {
        this.logger.error('[RealtimeGateway] OpenAI WebSocket is null');
        client.emit('ERROR', { message: 'Failed to create WebSocket connection' });
        return;
      }

      // Store connection
      this.openaiConnections.set(client.id, openaiWs);

      // Forward messages from OpenAI to client and track session state
      openaiWs.on('message', (data: Buffer | string) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Check if session is ready
          if (message.type === 'session.updated' || message.type === 'session.created') {
            this.sessionReady.set(client.id, true);
            this.logger.log(`[RealtimeGateway] Session ready for client ${client.id}`);
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
        const isReady = this.sessionReady.get(client.id) && openaiWs.readyState === 1;
        
        if (!isReady) {
          if (audioChunkCount === 0) {
            this.logger.debug(`[RealtimeGateway] Waiting for session to be ready. State: ${openaiWs.readyState}, Ready: ${this.sessionReady.get(client.id)}`);
          }
          return; // Wait for session to be ready
        }
        
        try {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.audio,
          }));
          audioChunkCount++;
          if (audioChunkCount % 50 === 0) {
            this.logger.debug(`[RealtimeGateway] Forwarded ${audioChunkCount} audio chunks to OpenAI`);
          }
        } catch (error: any) {
          this.logger.error(`[RealtimeGateway] Failed to send audio chunk: ${error.message}`);
        }
      });

      client.emit('TRANSCRIPTION_STARTED', { meetingId });
    } catch (error: any) {
      this.logger.error(`[RealtimeGateway] Start transcription error:`, {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      client.emit('ERROR', { 
        message: `Failed to start transcription: ${error.message || 'Unknown error'}` 
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
        this.logger.warn(`[RealtimeGateway] Cannot update language - No connection for client ${client.id}`);
        client.emit('ERROR', { message: 'Transcription not started' });
        return;
      }

      if (openaiWs.readyState !== 1) {
        this.logger.warn(`[RealtimeGateway] Cannot update language - WebSocket not ready (state: ${openaiWs.readyState}) for client ${client.id}`);
        client.emit('ERROR', { message: 'WebSocket connection not ready' });
        return;
      }

      if (!language) {
        client.emit('ERROR', { message: 'Language is required' });
        return;
      }

      const oldLanguage = this.clientLanguages.get(client.id) || 'en';
      if (oldLanguage === language) {
        this.logger.debug(`[RealtimeGateway] Language already set to ${language}, skipping update`);
        return;
      }

      this.logger.log(`[RealtimeGateway] 🔄 Updating transcription language from ${oldLanguage} to ${language} for client ${client.id}`);

      // Update stored language for this client
      // Note: OpenAI Realtime API doesn't support updating language mid-session
      // We'll just update our internal state so translations use the new language
      // The transcription will continue with the original language, but translations will use the new one
      this.clientLanguages.set(client.id, language);
      
      this.logger.log(`[RealtimeGateway] ✅ Language updated to ${language} (will be used for future translations)`);
      
      // Don't send session.update - OpenAI doesn't support partial updates and it causes connection to close
      // The transcription will continue with the original language, but all translations will use the new language
    } catch (error: any) {
      this.logger.error(`[RealtimeGateway] Failed to update language: ${error.message}`);
      client.emit('ERROR', { message: `Failed to update language: ${error.message}` });
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


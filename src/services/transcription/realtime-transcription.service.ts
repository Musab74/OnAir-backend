/**
 * OpenAI Realtime API Service
 * Proxies WebSocket connection for real-time transcription
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket = require('ws');

export interface RealtimeConfig {
  language?: string;
  onPartialResult?: (text: string) => void;
  onFinalResult?: (text: string, language: string) => void;
  onError?: (error: Error) => void;
}

@Injectable()
export class RealtimeTranscriptionService {
  private readonly logger = new Logger(RealtimeTranscriptionService.name);
  private readonly openaiApiKey: string;
  // OpenAI Realtime API URL - uses gpt-4o-realtime-preview model
  private readonly openaiRealtimeUrl =
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

  constructor(private configService: ConfigService) {
    this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (!this.openaiApiKey) {
      this.logger.error('OPENAI_API_KEY is not set in environment variables');
      throw new Error('OPENAI_API_KEY is required');
    }
  }

  /**
   * Create a proxy WebSocket connection to OpenAI Realtime API
   * Returns the proxy WebSocket that can be used to forward messages
   */
  createProxyConnection(config: RealtimeConfig): WebSocket {
    this.logger.log(
      `[RealtimeAPI] Creating connection to: ${this.openaiRealtimeUrl}`,
    );
    this.logger.log(`[RealtimeAPI] API Key present: ${!!this.openaiApiKey}`);

    try {
      const ws = new WebSocket(this.openaiRealtimeUrl, {
        headers: {
          Authorization: `Bearer ${this.openaiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', () => {
        this.logger.log('[RealtimeAPI] ✅ Connected to OpenAI Realtime API');

        // Send session configuration
        const sessionConfig: any = {
          type: 'session.update',
          session: {
            modalities: ['audio', 'text'], // Must include both audio and text
            instructions:
              'You are a real-time transcription assistant. Transcribe speech accurately.',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
              ...(config.language && { language: config.language }),
              // OpenAI Realtime API may automatically chunk very long audio streams
              // but we don't have direct control over this in the session config
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.4, // Higher threshold to filter out background noise (was 0.3)
              prefix_padding_ms: 200, // Reduced padding for faster response (was 300)
              silence_duration_ms: 400, // Longer silence to ensure speech is complete (was 300)
            },
          },
        };

        this.logger.log(
          '[RealtimeAPI] Sending session config:',
          JSON.stringify(sessionConfig, null, 2),
        );
        ws.send(JSON.stringify(sessionConfig));
      });

      ws.on('message', (data: Buffer | string) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleRealtimeMessage(message, config);
        } catch (error) {
          this.logger.error('[RealtimeAPI] Failed to parse message:', error);
        }
      });

      ws.on('error', (error: any) => {
        this.logger.error('[RealtimeAPI] ❌ WebSocket error:', {
          message: error.message,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          address: error.address,
          port: error.port,
        });
        config.onError?.(
          new Error(
            `Realtime API connection error: ${error.message || 'Unknown error'}`,
          ),
        );
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.logger.log(
          `[RealtimeAPI] WebSocket closed: code=${code}, reason=${reason.toString()}`,
        );
        // Code 1005 means "No Status Received" - can happen with partial session updates
        // Code 1000 is normal closure
        // Don't treat 1005 as fatal - it might be due to an unsupported session update
        if (code !== 1000 && code !== 1005) {
          config.onError?.(
            new Error(
              `WebSocket closed unexpectedly: ${reason.toString() || `code ${code}`}`,
            ),
          );
        } else if (code === 1005) {
          this.logger.warn(
            `[RealtimeAPI] WebSocket closed with code 1005 (no status) - may be due to unsupported session update`,
          );
        }
      });

      // Set a timeout to detect connection failures
      const connectionTimeout = setTimeout(() => {
        if (ws.readyState === 0) {
          // CONNECTING = 0
          this.logger.error(
            '[RealtimeAPI] Connection timeout - WebSocket took too long to connect',
          );
          ws.close();
          config.onError?.(
            new Error(
              'Connection timeout - OpenAI Realtime API did not respond',
            ),
          );
        }
      }, 10000); // 10 second timeout

      ws.on('open', () => {
        clearTimeout(connectionTimeout);
      });

      return ws;
    } catch (error: any) {
      this.logger.error('[RealtimeAPI] ❌ Failed to create WebSocket:', {
        message: error.message,
        stack: error.stack,
      });
      config.onError?.(
        new Error(`Failed to create WebSocket: ${error.message}`),
      );
      throw error; // Re-throw so gateway can catch it
    }
  }

  /**
   * Handle messages from OpenAI Realtime API
   */
  private handleRealtimeMessage(data: any, config: RealtimeConfig): void {
    this.logger.debug(`[RealtimeAPI] Received message type: ${data.type}`);

    switch (data.type) {
      case 'transcription.delta':
        // Partial transcription result (legacy format)
        if (data.delta) {
          this.logger.debug(`[RealtimeAPI] Partial: ${data.delta}`);
          config.onPartialResult?.(data.delta);
        }
        break;

      case 'transcription.done':
        // Final transcription result (legacy format)
        if (data.text) {
          this.logger.log(
            `[RealtimeAPI] Final: ${data.text} (${data.language || 'en'})`,
          );
          config.onFinalResult?.(data.text, data.language || 'en');
        } else {
          this.logger.warn(
            '[RealtimeAPI] transcription.done received but no text',
          );
        }
        break;

      case 'conversation.item.input_audio_transcription.delta':
        // Partial transcription result (new format)
        // The delta text is in data.delta
        if (data.delta) {
          this.logger.debug(
            `[RealtimeAPI] 📝 Partial transcription delta: ${data.delta}`,
          );
          config.onPartialResult?.(data.delta);
        } else {
          this.logger.debug(
            `[RealtimeAPI] Delta message but no delta field. Full data:`,
            JSON.stringify(data, null, 2),
          );
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Final transcription result (new format)
        // The transcript might be in data.item.input_audio_transcription.transcript
        // or data.transcript or data.text
        this.logger.debug(
          `[RealtimeAPI] Transcription completed. Full message:`,
          JSON.stringify(data, null, 2),
        );

        let transcript: string | null = null;
        let language = 'en';

        // Try different possible locations for the transcript
        if (data.item?.input_audio_transcription?.transcript) {
          transcript = data.item.input_audio_transcription.transcript;
          language = data.item.input_audio_transcription.language || language;
        } else if (data.transcript) {
          transcript = data.transcript;
          language = data.language || language;
        } else if (data.text) {
          transcript = data.text;
          language = data.language || language;
        } else if (data.item?.input_audio_transcription?.text) {
          transcript = data.item.input_audio_transcription.text;
          language = data.item.input_audio_transcription.language || language;
        }

        // Only process English and Korean - reject all other languages immediately
        const normalizedLang = language?.toLowerCase() || '';
        if (normalizedLang !== 'en' && normalizedLang !== 'ko') {
          this.logger.warn(
            `[RealtimeAPI] ⚠️ Rejected - unsupported language: ${language} for transcript: "${transcript}"`,
          );
          return; // Don't process non-English/Korean transcriptions
        }

        if (transcript) {
          this.logger.log(
            `[RealtimeAPI] ✅ Final transcription completed: "${transcript}" (${language})`,
          );
          config.onFinalResult?.(transcript, language);
        } else {
          this.logger.warn(
            '[RealtimeAPI] ⚠️ Transcription completed but could not extract transcript from message',
          );
        }
        break;

      case 'error':
        this.logger.error(
          '[RealtimeAPI] Error:',
          JSON.stringify(data.error || data),
        );
        config.onError?.(
          new Error(data.error?.message || data.message || 'Unknown error'),
        );
        break;

      case 'session.created':
      case 'session.updated':
        this.logger.log(`[RealtimeAPI] Session ${data.type}`);
        break;

      case 'response.audio_transcription.delta':
        // Alternative format for transcription delta
        if (data.delta) {
          this.logger.debug(`[RealtimeAPI] Transcription delta: ${data.delta}`);
          config.onPartialResult?.(data.delta);
        }
        break;

      case 'response.audio_transcription.done':
        // Alternative format for transcription done
        if (data.text) {
          this.logger.log(`[RealtimeAPI] Transcription done: ${data.text}`);
          config.onFinalResult?.(data.text, data.language || 'en');
        }
        break;

      default:
        // Log unknown message types for debugging (but ignore internal response messages)
        if (
          data.type &&
          !data.type.startsWith('response.') &&
          !data.type.startsWith('input_audio_buffer.') &&
          !data.type.startsWith('conversation.item.created') &&
          data.type !== 'response.created' &&
          data.type !== 'response.done'
        ) {
          this.logger.debug(
            `[RealtimeAPI] Unhandled message type: ${data.type}`,
            JSON.stringify(data, null, 2),
          );
        }
        break;
    }
  }
}

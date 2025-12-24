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
import { MemberService } from '../members/member.service';
import {
  TranscriptionService,
  SubtitleData,
} from '../../services/transcription/transcription.service';
import {
  SubscribeSubtitlesInput,
  UnsubscribeSubtitlesInput,
} from '../../libs/DTO/transcription/transcription.input';

interface AuthenticatedSocket extends Socket {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    systemRole?: string;
  };
  handshake: any;
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
  namespace: '/transcription',
})
export class TranscriptionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TranscriptionGateway.name);

  // Store participant language preferences per meeting
  private participantPreferences = new Map<string, Map<string, string>>(); // meetingId -> Map<userId, language>

  // Store active subtitle subscriptions
  private activeSubscriptions = new Map<string, Set<string>>(); // meetingId -> Set<socketId>

  // Map socketId to userId for quick lookups
  private socketToUserMap = new Map<string, string>(); // socketId -> userId

  // Map socketId to meetingId for quick lookups
  private socketToMeetingMap = new Map<string, string>(); // socketId -> meetingId

  constructor(
    private transcriptionService: TranscriptionService,
    private jwtService: JwtService,
    private memberService: MemberService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Extract token from handshake
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.emit('ERROR', { message: 'No authentication token provided' });
        client.disconnect();
        return;
      }

      // Verify JWT token
      let payload;
      try {
        payload = this.jwtService.verify(token);
      } catch (jwtError) {
        client.emit('ERROR', { message: 'Invalid authentication token' });
        client.disconnect();
        return;
      }

      const user = await this.memberService.getProfile(payload.sub);

      if (!user) {
        client.emit('ERROR', { message: 'User not found' });
        client.disconnect();
        return;
      }

      client.user = user;
      // Store socketId to userId mapping
      if (user._id) {
        this.socketToUserMap.set(client.id, user._id);
      }
      this.logger.log(
        `Client connected: ${client.id} (User: ${user.displayName})`,
      );
    } catch (error: any) {
      this.logger.error(`Connection error: ${error.message}`);
      client.emit('ERROR', { message: 'Connection failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Clean up subscriptions
    this.activeSubscriptions.forEach((socketIds, meetingId) => {
      if (socketIds.has(client.id)) {
        socketIds.delete(client.id);
        this.logger.log(`Removed subscription for meeting: ${meetingId}`);
      }
    });

    // Clean up mappings
    this.socketToUserMap.delete(client.id);
    this.socketToMeetingMap.delete(client.id);
  }

  /**
   * Subscribe to subtitles for a meeting
   * Client sends: SUBSCRIBE_SUBTITLES
   */
  @SubscribeMessage('SUBSCRIBE_SUBTITLES')
  async handleSubscribeSubtitles(
    @MessageBody() data: SubscribeSubtitlesInput,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      const { meetingId, language } = data;

      if (!meetingId || !language) {
        client.emit('ERROR', {
          message: 'Meeting ID and language are required',
        });
        return;
      }

      // STRICT: Only English and Korean are supported
      if (!language || typeof language !== 'string') {
        client.emit('ERROR', {
          message:
            'Language is required. Only English (en) and Korean (ko) are supported.',
        });
        return;
      }

      // Normalize and validate language code
      const normalizedLanguage = language.toLowerCase().trim();

      // ONLY accept 'en' or 'ko'
      if (normalizedLanguage !== 'en' && normalizedLanguage !== 'ko') {
        client.emit('ERROR', {
          message: `Invalid language code: "${language}". Only English (en) and Korean (ko) are supported.`,
        });
        return;
      }

      // Join the meeting room
      await client.join(meetingId);

      // Store language preference
      if (!this.participantPreferences.has(meetingId)) {
        this.participantPreferences.set(meetingId, new Map());
      }

      const user = (client as any).user;
      if (user && user._id) {
        // Store normalized language code
        this.participantPreferences
          .get(meetingId)!
          .set(user._id, normalizedLanguage);
        // Store socketId to userId mapping
        this.socketToUserMap.set(client.id, user._id);
      }

      // Track active subscription
      if (!this.activeSubscriptions.has(meetingId)) {
        this.activeSubscriptions.set(meetingId, new Set());
      }
      this.activeSubscriptions.get(meetingId)!.add(client.id);
      // Store socketId to meetingId mapping
      this.socketToMeetingMap.set(client.id, meetingId);

      this.logger.log(
        `Client ${client.id} subscribed to subtitles for meeting ${meetingId} with language ${normalizedLanguage}`,
      );

      // Send confirmation
      client.emit('SUBSCRIBE_SUCCESS', {
        meetingId,
        language: normalizedLanguage,
        message: 'Successfully subscribed to subtitles',
      });
    } catch (error: any) {
      this.logger.error(`Subscribe error: ${error.message}`);
      client.emit('ERROR', {
        message: 'Failed to subscribe to subtitles',
      });
    }
  }

  /**
   * Unsubscribe from subtitles
   * Client sends: UNSUBSCRIBE_SUBTITLES
   */
  @SubscribeMessage('UNSUBSCRIBE_SUBTITLES')
  async handleUnsubscribeSubtitles(
    @MessageBody() data: UnsubscribeSubtitlesInput,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      const { meetingId } = data;

      if (!meetingId) {
        client.emit('ERROR', {
          message: 'Meeting ID is required',
        });
        return;
      }

      // Leave the meeting room
      await client.leave(meetingId);

      // Remove subscription tracking
      if (this.activeSubscriptions.has(meetingId)) {
        this.activeSubscriptions.get(meetingId)!.delete(client.id);
      }

      this.logger.log(
        `Client ${client.id} unsubscribed from subtitles for meeting ${meetingId}`,
      );

      // Send confirmation
      client.emit('UNSUBSCRIBE_SUCCESS', {
        meetingId,
        message: 'Successfully unsubscribed from subtitles',
      });
    } catch (error: any) {
      this.logger.error(`Unsubscribe error: ${error.message}`);
      client.emit('ERROR', {
        message: 'Failed to unsubscribe from subtitles',
      });
    }
  }

  /**
   * Broadcast subtitle to all participants in a meeting
   * This is called internally by the transcription service
   * Each user receives subtitles in their preferred language
   */
  async broadcastSubtitle(meetingId: string, subtitleData: SubtitleData) {
    try {
      // Get all participants subscribed to this meeting
      const subscribers = this.activeSubscriptions.get(meetingId);

      this.logger.log(
        `[BROADCAST] Attempting to broadcast subtitle for meeting ${meetingId}`,
        {
          subscribersCount: subscribers?.size || 0,
          originalText: subtitleData.originalText,
          sourceLanguage: subtitleData.sourceLanguage,
          participantId: subtitleData.participantId,
        },
      );

      if (!subscribers || subscribers.size === 0) {
        this.logger.warn(
          `[BROADCAST] No subscribers for meeting ${meetingId}. Active subscriptions:`,
          Array.from(this.activeSubscriptions.entries()).map(([id, set]) => ({
            meetingId: id,
            count: set.size,
          })),
        );
        return;
      }

      // Get language preferences for this meeting
      const preferences =
        this.participantPreferences.get(meetingId) || new Map();
      const originalText = subtitleData.originalText;
      const sourceLanguage = (subtitleData.sourceLanguage || 'en')
        .toLowerCase()
        .trim();

      // STRICT: Only process English or Korean source languages
      if (sourceLanguage !== 'en' && sourceLanguage !== 'ko') {
        this.logger.warn(
          `[BROADCAST] Ignoring non-English/Korean source language: ${sourceLanguage}`,
        );
        return; // Don't broadcast if source is not English or Korean
      }

      // Group subscribers by their preferred language (only 'en' or 'ko')
      const languageGroups = new Map<string, string[]>(); // language -> socketIds[]

      // Iterate through all subscribed socket IDs
      for (const socketId of subscribers) {
        // Get userId from our mapping
        const userId = this.socketToUserMap.get(socketId);
        if (userId) {
          // Get user's preferred language (must be 'en' or 'ko')
          let userLang = preferences.get(userId) || 'en';
          userLang = userLang.toLowerCase().trim();

          // Validate user language - only accept 'en' or 'ko'
          if (userLang !== 'en' && userLang !== 'ko') {
            this.logger.warn(
              `[BROADCAST] Invalid user language preference: ${userLang}, defaulting to 'en'`,
            );
            userLang = 'en';
          }

          // STRICT MATCHING LOGIC: Only broadcast if source matches user's expected pattern
          // User wants English → only show if source is Korean (translate to English)
          // User wants Korean → only show if source is English (translate to Korean)
          // If source matches user's language, don't show (user already understands)
          const shouldShow =
            (userLang === 'en' && sourceLanguage === 'ko') ||
            (userLang === 'ko' && sourceLanguage === 'en');

          if (!shouldShow) {
            // Skip this user - they don't need translation (source matches their language)
            continue;
          }

          if (!languageGroups.has(userLang)) {
            languageGroups.set(userLang, []);
          }
          languageGroups.get(userLang)!.push(socketId);
        } else {
          // No user mapping - skip (don't default to English to avoid wrong translations)
          this.logger.warn(
            `[BROADCAST] No userId mapping found for socket ${socketId}, skipping broadcast`,
          );
        }
      }

      // If no users need translation, skip processing
      if (languageGroups.size === 0) {
        this.logger.log(
          `[BROADCAST] No users need translation (source: ${sourceLanguage}, all users speak this language)`,
        );
        return;
      }

      // Translate to each unique language needed (in parallel for speed)
      const translationPromises: Array<
        Promise<{ language: string; translatedText: string }>
      > = [];

      for (const [targetLang, socketIds] of languageGroups.entries()) {
        // Validate target language
        if (targetLang !== 'en' && targetLang !== 'ko') {
          this.logger.warn(
            `[BROADCAST] Invalid target language: ${targetLang}, skipping`,
          );
          continue;
        }

        // Always translate (we already filtered users who don't need translation)
        translationPromises.push(
          this.transcriptionService
            .translateText(originalText, targetLang, sourceLanguage)
            .then((result) => ({
              language: targetLang,
              translatedText: result.translatedText || originalText,
            }))
            .catch((error) => {
              this.logger.error(
                `[BROADCAST] Translation failed for ${targetLang}: ${error.message}`,
              );
              // Return empty to prevent showing wrong text
              return { language: targetLang, translatedText: '' };
            }),
        );
      }

      // Wait for all translations to complete in parallel
      // Use allSettled to ensure one failure doesn't stop others
      const translationResults = await Promise.allSettled(translationPromises);

      // Create a map of language -> translated text for quick lookup
      const translationMap = new Map<string, string>();
      const languageList = Array.from(languageGroups.keys());
      translationResults.forEach((result, index) => {
        const targetLang = languageList[index];
        if (result.status === 'fulfilled') {
          const { translatedText } = result.value;
          translationMap.set(targetLang, translatedText);
        } else {
          // If translation failed, log as error and notify users
          this.logger.error(
            `[BROADCAST] ❌ TRANSLATION PROMISE REJECTED for ${targetLang}. Error: ${result.reason?.message || 'Unknown error'}`,
          );
          // Don't use original text - it's wrong language! Return empty so it gets skipped with error notification
          translationMap.set(targetLang, '');

          // Notify affected users
          const failedSocketIds = languageGroups.get(targetLang) || [];
          for (const socketId of failedSocketIds) {
            this.server.to(socketId).emit('TRANSLATION_ERROR', {
              message: `Translation failed for ${targetLang}. Please check your connection and try again.`,
              originalText: originalText.substring(0, 100),
              targetLanguage: targetLang,
              error: result.reason?.message || 'Translation promise rejected',
              timestamp: Date.now(),
            });
          }
        }
      });

      // Send personalized subtitles to each subscriber
      let sentCount = 0;
      for (const [targetLang, socketIds] of languageGroups.entries()) {
        const translatedText = translationMap.get(targetLang) || '';

        // Skip if translation is empty (translation failed or filtered out)
        if (!translatedText || translatedText.trim().length === 0) {
          this.logger.error(
            `[BROADCAST] ❌ TRANSLATION FAILED SILENTLY for ${targetLang} - empty translation result. Original: "${originalText.substring(0, 50)}"`,
          );
          // Notify affected users that translation failed
          for (const socketId of socketIds) {
            this.server.to(socketId).emit('TRANSLATION_ERROR', {
              message: `Translation failed for language ${targetLang}. Please try again.`,
              originalText: originalText.substring(0, 100),
              targetLanguage: targetLang,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        const broadcastData = {
          meetingId: subtitleData.meetingId,
          participantId: subtitleData.participantId,
          participantName: (subtitleData as any).participantName || 'Unknown',
          originalText: originalText,
          translatedText: translatedText.trim(),
          sourceLanguage: sourceLanguage,
          targetLanguage: targetLang,
          timestamp: subtitleData.timestamp,
        };

        // Send to all sockets that want this language
        for (const socketId of socketIds) {
          this.server.to(socketId).emit('SUBTITLE_UPDATE', broadcastData);
          sentCount++;
        }
      }

      this.logger.log(
        `[BROADCAST] Successfully broadcasted personalized subtitles to ${sentCount} subscribers in meeting ${meetingId}`,
        {
          languagesUsed: Array.from(languageGroups.keys()),
          originalText: originalText.substring(0, 50),
        },
      );
    } catch (error: any) {
      this.logger.error(
        `[BROADCAST] Broadcast subtitle error: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Get participant language preference for a meeting
   */
  getParticipantLanguage(
    meetingId: string,
    userId: string,
  ): string | undefined {
    const preferences = this.participantPreferences.get(meetingId);
    return preferences?.get(userId);
  }

  /**
   * Set participant language preference
   */
  setParticipantLanguage(meetingId: string, userId: string, language: string) {
    if (!this.participantPreferences.has(meetingId)) {
      this.participantPreferences.set(meetingId, new Map());
    }
    this.participantPreferences.get(meetingId)!.set(userId, language);
  }
}

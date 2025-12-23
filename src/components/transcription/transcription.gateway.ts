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
import { TranscriptionService, SubtitleData } from '../../services/transcription/transcription.service';
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
  private participantPreferences = new Map<
    string,
    Map<string, string>
  >(); // meetingId -> Map<userId, language>

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
      this.logger.log(`Client connected: ${client.id} (User: ${user.displayName})`);
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

      // Validate language - accept any 2-letter language code
      // OpenAI GPT can translate to/from any language, so we accept any valid language code
      if (!language || typeof language !== 'string' || language.length < 2) {
        client.emit('ERROR', {
          message: 'Invalid language code. Language must be a valid 2-letter code (e.g., en, ko, ja, zh, es, fr, etc.)',
        });
        return;
      }
      
      // Normalize language code to lowercase
      const normalizedLanguage = language.toLowerCase();

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

      this.logger.log(`[BROADCAST] Attempting to broadcast subtitle for meeting ${meetingId}`, {
        subscribersCount: subscribers?.size || 0,
        originalText: subtitleData.originalText,
        sourceLanguage: subtitleData.sourceLanguage,
        participantId: subtitleData.participantId,
      });

      if (!subscribers || subscribers.size === 0) {
        this.logger.warn(`[BROADCAST] No subscribers for meeting ${meetingId}. Active subscriptions:`, 
          Array.from(this.activeSubscriptions.entries()).map(([id, set]) => ({ meetingId: id, count: set.size }))
        );
        return;
      }

      // Get language preferences for this meeting
      const preferences = this.participantPreferences.get(meetingId) || new Map();
      const originalText = subtitleData.originalText;
      const sourceLanguage = subtitleData.sourceLanguage || 'en';

      // Group subscribers by their preferred language to minimize translation API calls
      const languageGroups = new Map<string, string[]>(); // language -> socketIds[]
      
      // Iterate through all subscribed socket IDs
      for (const socketId of subscribers) {
        // Get userId from our mapping
        const userId = this.socketToUserMap.get(socketId);
        if (userId) {
          // Get user's preferred language
          const userLang = preferences.get(userId) || 'en';
          if (!languageGroups.has(userLang)) {
            languageGroups.set(userLang, []);
          }
          languageGroups.get(userLang)!.push(socketId);
        } else {
          // Fallback to English if user mapping not found (shouldn't happen, but handle gracefully)
          const defaultLang = 'en';
          if (!languageGroups.has(defaultLang)) {
            languageGroups.set(defaultLang, []);
          }
          languageGroups.get(defaultLang)!.push(socketId);
          this.logger.warn(`[BROADCAST] No userId mapping found for socket ${socketId}, using default language`);
        }
      }

      // Translate to each unique language needed (in parallel for speed)
      const translationPromises: Array<Promise<{ language: string; translatedText: string }>> = [];
      
      for (const [targetLang, socketIds] of languageGroups.entries()) {
        // If source and target are the same, no translation needed
        if (sourceLanguage.toLowerCase() === targetLang.toLowerCase()) {
          translationPromises.push(
            Promise.resolve({ language: targetLang, translatedText: originalText })
          );
        } else {
          // Translate to target language
          translationPromises.push(
            this.transcriptionService
              .translateText(originalText, targetLang, sourceLanguage)
              .then((result) => ({
                language: targetLang,
                translatedText: result.translatedText || originalText,
              }))
              .catch((error) => {
                this.logger.error(`[BROADCAST] Translation failed for ${targetLang}: ${error.message}`);
                // Fallback to original text if translation fails
                return { language: targetLang, translatedText: originalText };
              })
          );
        }
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
          // If translation failed, use original text to prevent speech loss
          this.logger.warn(`[BROADCAST] Translation failed for ${targetLang}, using original text`);
          translationMap.set(targetLang, originalText);
        }
      });

      // Send personalized subtitles to each subscriber
      let sentCount = 0;
      for (const [targetLang, socketIds] of languageGroups.entries()) {
        const translatedText = translationMap.get(targetLang) || originalText;

        const broadcastData = {
          meetingId: subtitleData.meetingId,
          participantId: subtitleData.participantId,
          participantName: (subtitleData as any).participantName || 'Unknown',
          originalText: originalText,
          translatedText: translatedText,
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
        }
      );
    } catch (error: any) {
      this.logger.error(`[BROADCAST] Broadcast subtitle error: ${error.message}`, error.stack);
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
  setParticipantLanguage(
    meetingId: string,
    userId: string,
    language: string,
  ) {
    if (!this.participantPreferences.has(meetingId)) {
      this.participantPreferences.set(meetingId, new Map());
    }
    this.participantPreferences.get(meetingId)!.set(userId, language);
  }
}


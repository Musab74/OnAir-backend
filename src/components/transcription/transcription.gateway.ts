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
      'http://localhost:3000',
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

      // Validate language
      const supportedLanguages =
        this.transcriptionService.getSupportedLanguages();
      const isValidLanguage = supportedLanguages.some(
        (lang) => lang.code === language,
      );

      if (!isValidLanguage) {
        client.emit('ERROR', {
          message: `Unsupported language: ${language}`,
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
        this.participantPreferences
          .get(meetingId)!
          .set(user._id, language);
      }

      // Track active subscription
      if (!this.activeSubscriptions.has(meetingId)) {
        this.activeSubscriptions.set(meetingId, new Set());
      }
      this.activeSubscriptions.get(meetingId)!.add(client.id);

      this.logger.log(
        `Client ${client.id} subscribed to subtitles for meeting ${meetingId} with language ${language}`,
      );

      // Send confirmation
      client.emit('SUBSCRIBE_SUCCESS', {
        meetingId,
        language,
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
   */
  broadcastSubtitle(meetingId: string, subtitleData: SubtitleData) {
    try {
      // Get all participants subscribed to this meeting
      const subscribers = this.activeSubscriptions.get(meetingId);

      this.logger.log(`[BROADCAST] Attempting to broadcast subtitle for meeting ${meetingId}`, {
        subscribersCount: subscribers?.size || 0,
        subtitleText: subtitleData.translatedText,
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

      const broadcastData = {
        meetingId: subtitleData.meetingId,
        participantId: subtitleData.participantId,
        participantName: (subtitleData as any).participantName || 'Unknown',
        originalText: subtitleData.originalText,
        translatedText: subtitleData.translatedText,
        sourceLanguage: subtitleData.sourceLanguage,
        targetLanguage: subtitleData.targetLanguage,
        timestamp: subtitleData.timestamp,
      };

      // Broadcast to all subscribers
      // Each subscriber will receive subtitles in their preferred language
      this.server.to(meetingId).emit('SUBTITLE_UPDATE', broadcastData);

      this.logger.log(
        `[BROADCAST] Successfully broadcasted subtitle to ${subscribers.size} subscribers in meeting ${meetingId}`,
        { translatedText: subtitleData.translatedText }
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


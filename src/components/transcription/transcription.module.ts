import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionGateway } from './transcription.gateway';
import { RealtimeTranscriptionGateway } from './realtime-transcription.gateway';
import { TranscriptionServiceModule } from '../../services/transcription/transcription.module';
import { RealtimeTranscriptionService } from '../../services/transcription/realtime-transcription.service';
import { MemberModule } from '../members/member.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TranscriptionServiceModule,
    MemberModule,
    AuthModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret || secret.trim().length === 0) {
          throw new Error(
            'JWT_SECRET is not set or is empty in .env file!',
          );
        }
        return {
          secret: secret,
          signOptions: { expiresIn: '24h' },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [TranscriptionController],
  providers: [
    TranscriptionGateway,
    RealtimeTranscriptionGateway,
    RealtimeTranscriptionService,
  ],
  exports: [TranscriptionGateway, RealtimeTranscriptionGateway],
})
export class TranscriptionModule {}


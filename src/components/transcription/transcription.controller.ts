import {
  Controller,
  Post,
  Get,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
  UseGuards,
  Request,
  UsePipes,
} from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TranscriptionService } from '../../services/transcription/transcription.service';
import { TranscriptionGateway } from './transcription.gateway';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  TranscribeInput,
  TranslateInput,
  TranscribeAndTranslateInput,
} from '../../libs/DTO/transcription/transcription.input';

@Controller('api/transcription')
@UseGuards(AuthGuard)
export class TranscriptionController {
  private readonly logger = new Logger(TranscriptionController.name);

  constructor(
    private transcriptionService: TranscriptionService,
    private transcriptionGateway: TranscriptionGateway,
  ) {}

  /**
   * POST /api/transcription/transcribe
   * Transcribe audio file to text
   */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio'))
  async transcribe(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: TranscribeInput,
  ) {
    if (!file) {
      throw new BadRequestException('Audio file is required');
    }

    try {
      // Validate audio format
      if (!this.transcriptionService.validateAudioFormat(file.buffer)) {
        throw new BadRequestException('Invalid audio file format or size');
      }

      // Transcribe audio
      const result = await this.transcriptionService.transcribeAudio(
        file.buffer,
        body.language,
      );

      this.logger.log(`Transcription completed for file: ${file.originalname}`);

      return {
        success: true,
        data: {
          text: result.text,
          language: result.language,
          duration: result.duration,
        },
      };
    } catch (error: any) {
      this.logger.error(`Transcription error: ${error.message}`);
      throw new BadRequestException(`Transcription failed: ${error.message}`);
    }
  }

  /**
   * POST /api/transcription/translate
   * Translate text to target language
   */
  @Post('translate')
  async translate(@Body() body: TranslateInput) {
    if (!body.text || !body.targetLanguage) {
      throw new BadRequestException('Text and target language are required');
    }

    try {
      const result = await this.transcriptionService.translateText(
        body.text,
        body.targetLanguage,
        body.sourceLanguage,
      );

      return {
        success: true,
        data: {
          originalText: body.text,
          translatedText: result.translatedText,
          sourceLanguage: result.sourceLanguage,
          targetLanguage: result.targetLanguage,
        },
      };
    } catch (error: any) {
      this.logger.error(`Translation error: ${error.message}`);
      throw new BadRequestException(`Translation failed: ${error.message}`);
    }
  }

  /**
   * POST /api/transcription/transcribe-and-translate
   * Transcribe audio and translate in one call
   */
  @Post('transcribe-and-translate')
  @UseInterceptors(FileInterceptor('audio'))
  @UsePipes(new ValidationPipe({ 
    skipMissingProperties: true, 
    transform: false, 
    whitelist: false,
    forbidNonWhitelisted: false,
    validateCustomDecorators: false,
  }))
  async transcribeAndTranslate(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Request() req: any,
  ) {
    // Debug logging - FormData fields are parsed by multer into body
    this.logger.log('[CONTROLLER] Received transcribe-and-translate request:', {
      hasFile: !!file,
      fileSize: file?.size,
      fileName: file?.originalname,
      bodyKeys: Object.keys(body || {}),
      body: body,
      reqBodyKeys: Object.keys(req.body || {}),
      reqBody: req.body,
    });

    if (!file) {
      throw new BadRequestException('Audio file is required');
    }

    // Extract fields from body (multer parses FormData fields into body)
    // Try both body and req.body as fallback
    const targetLanguage = body?.targetLanguage || req.body?.targetLanguage;
    const meetingId = body?.meetingId || req.body?.meetingId;

    this.logger.log('[CONTROLLER] Extracted fields:', { 
      targetLanguage, 
      meetingId,
      bodyFields: body,
      reqBodyFields: req.body,
    });

    if (!targetLanguage) {
      this.logger.error('[CONTROLLER] Missing targetLanguage', { 
        body: body,
        reqBody: req.body,
        bodyKeys: Object.keys(body || {}),
        reqBodyKeys: Object.keys(req.body || {}),
      });
      throw new BadRequestException(
        `Target language is required. Body: ${JSON.stringify(body || {})}, ReqBody: ${JSON.stringify(req.body || {})}`
      );
    }

    if (!meetingId) {
      this.logger.error('[CONTROLLER] Missing meetingId', { 
        body: body,
        reqBody: req.body,
        bodyKeys: Object.keys(body || {}),
        reqBodyKeys: Object.keys(req.body || {}),
      });
      throw new BadRequestException(
        `Meeting ID is required. Body: ${JSON.stringify(body || {})}, ReqBody: ${JSON.stringify(req.body || {})}`
      );
    }

    try {
      // Log file details
      this.logger.log('[CONTROLLER] Audio file details:', {
        size: file.size,
        mimetype: file.mimetype,
        originalname: file.originalname,
        bufferLength: file.buffer?.length,
        firstBytes: file.buffer?.slice(0, 20).toString('hex'),
      });

      // Validate audio format
      if (!this.transcriptionService.validateAudioFormat(file.buffer)) {
        this.logger.error('[CONTROLLER] Audio validation failed:', {
          size: file.size,
          bufferLength: file.buffer?.length,
        });
        throw new BadRequestException('Invalid audio file format or size');
      }

      this.logger.log('[CONTROLLER] Audio validation passed, starting transcription...');

      // Transcribe and translate - pass mimetype to ensure correct format
      const result = await this.transcriptionService.transcribeAndTranslate(
        file.buffer,
        targetLanguage,
        file.mimetype, // Pass mimetype to determine file format
      );

      // Get user info from request (set by AuthGuard)
      const user = req.user;
      const participantId = user?._id || user?.id || 'unknown';
      const participantName = user?.displayName || user?.name || 'Unknown';

      // Validate that we have meaningful text to broadcast
      const originalText = result.transcription.text?.trim() || '';
      const translatedText = result.translation.translatedText?.trim() || '';
      
      // Skip broadcasting if text is empty or too short
      if (!translatedText || translatedText.length < 2) {
        this.logger.debug(`[CONTROLLER] Skipping broadcast - empty or too short text:`, {
          originalText,
          translatedText,
          originalLength: originalText.length,
          translatedLength: translatedText.length,
        });
        return {
          success: true,
          data: {
            originalText,
            translatedText,
            sourceLanguage: result.transcription.language,
            targetLanguage: result.translation.targetLanguage,
            duration: result.transcription.duration,
            skipped: true,
            reason: 'Text too short or empty',
          },
        };
      }

      // Format subtitle data - use actual detected language from transcription
      const sourceLanguage = result.transcription.language || result.translation.sourceLanguage || 'en';
      const subtitleData = this.transcriptionService.formatSubtitleData(
        participantId,
        originalText,
        translatedText,
        sourceLanguage, // Use actual detected language
        result.translation.targetLanguage,
        meetingId,
      );

      // Broadcast subtitle via WebSocket
      this.logger.log(`[CONTROLLER] Broadcasting subtitle for meeting ${meetingId}`, {
        translatedText,
        originalText,
        participantId,
        participantName,
        sourceLanguage: result.transcription.language,
        targetLanguage: result.translation.targetLanguage,
      });

      // Broadcast subtitle (now async) - don't wait for it to complete
      this.transcriptionGateway.broadcastSubtitle(meetingId, {
        ...subtitleData,
        participantName,
      } as any).catch((error) => {
        this.logger.error(`[CONTROLLER] Broadcast subtitle error: ${error.message}`);
      });

      this.logger.log(
        `[CONTROLLER] Transcription and translation completed for meeting ${meetingId}`,
        { translatedText: result.translation.translatedText }
      );

      return {
        success: true,
        data: {
          originalText: result.transcription.text,
          translatedText: result.translation.translatedText,
          sourceLanguage: result.transcription.language,
          targetLanguage: result.translation.targetLanguage,
          duration: result.transcription.duration,
        },
      };
    } catch (error: any) {
      this.logger.error(`Transcribe and translate error: ${error.message}`);
      throw new BadRequestException(
        `Transcribe and translate failed: ${error.message}`,
      );
    }
  }

  /**
   * GET /api/transcription/languages
   * Get list of supported languages
   */
  @Get('languages')
  async getLanguages() {
    const languages = this.transcriptionService.getSupportedLanguages();

    return {
      success: true,
      data: {
        languages,
      },
    };
  }
}


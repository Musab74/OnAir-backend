import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptionResult {
  text: string;
  language: string;
  duration?: number;
}

export interface TranslationResult {
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface SubtitleData {
  participantId: string;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  timestamp: number;
  meetingId: string;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly openaiApiKey: string;
  private readonly openaiBaseUrl = 'https://api.openai.com/v1';
  private readonly axiosInstance: AxiosInstance;
  private readonly chunkSize: number = 10; // seconds
  // Only support English and Korean
  private readonly supportedLanguages = [
    { code: 'en', name: 'English' },
    { code: 'ko', name: 'Korean' },
  ];

  constructor(private configService: ConfigService) {
    this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY');
    
    if (!this.openaiApiKey) {
      this.logger.error('OPENAI_API_KEY is not set in environment variables');
      throw new Error('OPENAI_API_KEY is required');
    }

    // Initialize Axios instance with OpenAI API configuration
    this.axiosInstance = axios.create({
      baseURL: this.openaiBaseUrl,
      headers: {
        'Authorization': `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'multipart/form-data',
      },
      timeout: 30000, // 30 seconds timeout
    });

    this.logger.log('TranscriptionService initialized');
  }

  /**
   * Transcribe audio to text using OpenAI Whisper API
   * @param audioFile - Audio file buffer or path
   * @param language - Optional language code (auto-detect if not provided)
   * @param mimetype - Optional mimetype to determine file format
   * @returns Transcription result with text and detected language
   */
  async transcribeAudio(
    audioFile: Buffer | string,
    language?: string,
    mimetype?: string,
  ): Promise<TranscriptionResult> {
    try {
      this.logger.log(`Starting transcription${language ? ` for language: ${language}` : ' (auto-detect)'}`);

      const formData = new FormData();

      // Handle both Buffer and file path
      if (typeof audioFile === 'string') {
        // File path
        formData.append('file', fs.createReadStream(audioFile));
      } else {
        // Buffer - determine format from mimetype or default to webm
        // OpenAI Whisper supports: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
        const formatMap: Record<string, { ext: string; contentType: string }> = {
          'audio/webm': { ext: 'webm', contentType: 'audio/webm' },
          'audio/wav': { ext: 'wav', contentType: 'audio/wav' },
          'audio/mpeg': { ext: 'mp3', contentType: 'audio/mpeg' },
          'audio/mp3': { ext: 'mp3', contentType: 'audio/mpeg' },
          'audio/mp4': { ext: 'm4a', contentType: 'audio/mp4' },
          'audio/m4a': { ext: 'm4a', contentType: 'audio/mp4' },
          'audio/ogg': { ext: 'ogg', contentType: 'audio/ogg' },
          'audio/flac': { ext: 'flac', contentType: 'audio/flac' },
        };

        const format = mimetype && formatMap[mimetype] 
          ? formatMap[mimetype]
          : { ext: 'webm', contentType: 'audio/webm' }; // Default to webm for browser recordings

        this.logger.log(`[OpenAI] Using file format:`, {
          mimetype: mimetype || 'not provided',
          detectedFormat: format,
          bufferSize: audioFile.length,
        });

        formData.append('file', audioFile, {
          filename: `audio.${format.ext}`,
          contentType: format.contentType,
        });
      }

      formData.append('model', 'whisper-1');
      
      if (language) {
        formData.append('language', language);
      }

      // Optional: Add response format
      formData.append('response_format', 'json');

      this.logger.log(`[OpenAI] Sending transcription request:`, {
        fileSize: typeof audioFile === 'string' ? 'file path' : audioFile.length,
        language: language || 'auto-detect',
        model: 'whisper-1',
      });

      const response = await this.axiosInstance.post(
        '/audio/transcriptions',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      // Get detected language from Whisper (it returns language code like 'en', 'ko', etc.)
      const detectedLanguage = response.data.language || 'en'; // Default to English if not detected
      
      const result: TranscriptionResult = {
        text: response.data.text || '',
        language: detectedLanguage, // Use actual detected language, not 'unknown'
        duration: response.data.duration,
      };
      
      this.logger.log(`Transcription completed: ${result.text.substring(0, 50)}... (detected language: ${detectedLanguage})`);
      return result;
    } catch (error: any) {
      // Enhanced error logging for OpenAI API errors
      let errorDetails = error.message;
      
      if (error.response) {
        // OpenAI API returned an error response
        errorDetails = `OpenAI API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
        this.logger.error(`[OpenAI] API Error Response:`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
        });
      } else if (error.request) {
        // Request was made but no response received
        errorDetails = `No response from OpenAI API: ${error.message}`;
        this.logger.error(`[OpenAI] No response received:`, error.request);
      } else {
        // Error setting up the request
        errorDetails = `Request setup error: ${error.message}`;
        this.logger.error(`[OpenAI] Request setup error:`, error);
      }
      
      this.logger.error(`[OpenAI] Transcription failed: ${errorDetails}`, error.stack);
      throw new Error(`Transcription failed: ${errorDetails}`);
    }
  }

  /**
   * Translate text to target language using OpenAI Translation API
   * Note: Whisper API can also translate directly, but this method uses text translation
   * @param text - Text to translate
   * @param targetLanguage - Target language code
   * @param sourceLanguage - Optional source language code
   * @returns Translation result
   */
  async translateText(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<TranslationResult> {
    try {
      // Validate input text
      const trimmedText = text?.trim() || '';
      if (!trimmedText || trimmedText.length < 2) {
        this.logger.warn(`Skipping translation - text is empty or too short: "${trimmedText}"`);
        return {
          translatedText: '',
          sourceLanguage: sourceLanguage || 'en', // Default to English instead of unknown
          targetLanguage,
        };
      }

      this.logger.log(`Translating text to ${targetLanguage}${sourceLanguage ? ` from ${sourceLanguage}` : ''}`, {
        textLength: trimmedText.length,
        textPreview: trimmedText.substring(0, 50),
      });

      // Use OpenAI Chat API for ultra-fast translation
      // Maximum speed optimizations: minimal model, lowest temperature, minimal tokens, shorter timeout
      // For Korean: Use respectful form (존댓말) - always polite
      const isKorean = targetLanguage.toLowerCase() === 'ko';
      const systemPrompt = isKorean
        ? `Translate to Korean using respectful form (존댓말). Use polite endings like -습니다, -세요, -어요, -네요. Always use 존댓말, never 반말. Translation only, no explanations.`
        : `Translate to ${this.getLanguageName(targetLanguage)}. Translation only.`;
      
      const response = await this.axiosInstance.post(
        '/chat/completions',
        {
          model: 'gpt-3.5-turbo', // Fastest and cheapest model (already using it)
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: trimmedText,
            },
          ],
          temperature: 0, // Zero temperature for fastest, most deterministic responses
          max_tokens: Math.min(trimmedText.length * 1.5, 300), // Even more aggressive token limit for speed
          stream: false,
          n: 1, // Single response
          top_p: 1, // Default for speed
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 3000, // 3 second timeout (reduced from 5s) for faster failure handling
        },
      );

      let translatedText = response.data.choices[0]?.message?.content?.trim() || trimmedText;

      // Filter vulgar words from translation as well
      if (this.containsVulgarWords(translatedText)) {
        this.logger.warn(`[Translation] Rejected translation - contains vulgar words: "${translatedText}"`);
        // Return empty translation instead of vulgar content
        translatedText = '';
      }

      const result: TranslationResult = {
        translatedText,
        sourceLanguage: sourceLanguage || 'auto',
        targetLanguage,
      };

      this.logger.log(`Translation completed`);
      return result;
    } catch (error: any) {
      this.logger.error(`Translation failed: ${error.message}`, error.stack);
      // Fallback: return original text if translation fails
      return {
        translatedText: text,
        sourceLanguage: sourceLanguage || 'unknown',
        targetLanguage,
      };
    }
  }

  /**
   * Transcribe and translate audio in one call using Whisper API
   * This is more efficient than separate calls
   * @param audioFile - Audio file buffer or path
   * @param targetLanguage - Target language for translation
   * @param mimetype - Optional mimetype to determine file format
   * @returns Combined transcription and translation result
   */
  async transcribeAndTranslate(
    audioFile: Buffer | string,
    targetLanguage: string,
    mimetype?: string,
  ): Promise<{ transcription: TranscriptionResult; translation: TranslationResult }> {
    try {
      // First, transcribe the audio
      const transcription = await this.transcribeAudio(audioFile, undefined, mimetype);

      // Validate transcription text - skip if empty or too short
      const trimmedText = transcription.text?.trim() || '';
      const minTextLength = 2; // Minimum characters to consider valid

      if (trimmedText.length < minTextLength) {
        this.logger.debug(`Skipping translation - text too short: "${trimmedText}" (${trimmedText.length} chars)`);
        // Return empty translation result
        return {
          transcription,
          translation: {
            translatedText: '',
            sourceLanguage: transcription.language || 'unknown',
            targetLanguage,
          },
        };
      }

      // Only translate if source and target languages are different
      // Normalize language codes (Whisper returns 'en', 'ko', etc.)
      const sourceLang = transcription.language || 'en';
      const normalizedSource = sourceLang.toLowerCase();
      const normalizedTarget = targetLanguage.toLowerCase();
      
      // Only support English and Korean - reject other languages
      const supportedLanguages = ['en', 'ko'];
      // Keep the detected language only if it's English or Korean, otherwise reject
      const finalSourceLang = supportedLanguages.includes(normalizedSource) ? normalizedSource : null;
      const finalTargetLang = supportedLanguages.includes(normalizedTarget) ? normalizedTarget : 'en';
      
      // If source language is not English or Korean, reject the transcription
      if (!finalSourceLang) {
        this.logger.warn(`[Translation] Rejected - unsupported source language: ${normalizedSource}`);
        return {
          transcription: {
            text: '',
            language: normalizedSource,
            duration: 0,
          },
          translation: {
            translatedText: '',
            sourceLanguage: normalizedSource,
            targetLanguage,
          },
        };
      }
      
      this.logger.log(`[Translation] Language mapping:`, {
        detected: sourceLang,
        normalizedSource,
        finalSourceLang,
        targetLanguage,
        normalizedTarget,
        finalTargetLang,
        willTranslate: finalSourceLang !== finalTargetLang,
      });
      
      if (finalSourceLang === finalTargetLang) {
        // Same language - no translation needed
        this.logger.debug(`Skipping translation - same language: ${finalSourceLang}`);
        return {
          transcription: {
            ...transcription,
            language: finalSourceLang,
          },
          translation: {
            translatedText: trimmedText,
            sourceLanguage: finalSourceLang,
            targetLanguage: finalTargetLang,
          },
        };
      }

      // Then, translate the transcribed text (only if different language)
      const translation = await this.translateText(
        trimmedText,
        finalTargetLang,
        finalSourceLang,
      );

        return {
          transcription: {
            ...transcription,
            text: trimmedText,
            language: finalSourceLang, // Use normalized language
          },
          translation: {
            ...translation,
            sourceLanguage: finalSourceLang,
            targetLanguage: finalTargetLang,
          },
        };
    } catch (error: any) {
      this.logger.error(`Transcribe and translate failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Format subtitle data for broadcasting
   * @param participantId - Participant ID
   * @param originalText - Original transcribed text
   * @param translatedText - Translated text
   * @param sourceLanguage - Source language code
   * @param targetLanguage - Target language code
   * @param meetingId - Meeting ID
   * @returns Formatted subtitle data
   */
  formatSubtitleData(
    participantId: string,
    originalText: string,
    translatedText: string,
    sourceLanguage: string,
    targetLanguage: string,
    meetingId: string,
  ): SubtitleData {
    return {
      participantId,
      originalText,
      translatedText,
      sourceLanguage,
      targetLanguage,
      timestamp: Date.now(),
      meetingId,
    };
  }

  /**
   * Get supported languages
   * @returns Array of supported language codes and names
   */
  getSupportedLanguages(): Array<{ code: string; name: string }> {
    return this.supportedLanguages;
  }

  /**
   * Get language name from code
   * @param code - Language code
   * @returns Language name
   */
  private getLanguageName(code: string): string {
    const lang = this.supportedLanguages.find((l) => l.code === code);
    return lang ? lang.name : code;
  }

  /**
   * Check if text contains vulgar or disrespectful words
   */
  private containsVulgarWords(text: string): boolean {
    const lowerText = text.toLowerCase();
    
    // Common vulgar/profane words (English)
    const vulgarWords = [
      'fuck', 'shit', 'damn', 'hell', 'ass', 'bitch', 'bastard', 'crap',
      'piss', 'dick', 'cock', 'pussy', 'cunt', 'whore', 'slut', 'fag',
      'nigger', 'nigga', 'retard', 'idiot', 'stupid', 'dumb', 'moron',
      'damn', 'goddamn', 'bloody', 'screw', 'screw you', 'screw off',
      // Add more as needed
    ];
    
    // Check for vulgar words
    for (const word of vulgarWords) {
      if (lowerText.includes(word)) {
        this.logger.debug(`[Quality] Rejected - contains vulgar word: "${text}"`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Validate transcription quality to prevent hallucinations and background noise
   * Returns true if transcription is valid and should be displayed
   */
  validateTranscriptionQuality(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }

    const trimmed = text.trim();
    
    // Minimum length check - too short might be noise
    if (trimmed.length < 3) { // Minimum 3 characters
      this.logger.debug(`[Quality] Rejected - too short: "${trimmed}"`);
      return false;
    }

    // Check for vulgar/disrespectful words
    if (this.containsVulgarWords(trimmed)) {
      return false;
    }

    // Check for common hallucination patterns (expanded list)
    const hallucinationPatterns = [
      /thank you for watching/i,
      /thanks for watching/i,
      /please subscribe/i,
      /like and subscribe/i,
      /see you next time/i,
      /goodbye/i,
      /farewell/i,
      /end of transcript/i,
      /transcription/i,
      /^\.+$/, // Only dots
      /^[^\w\s]+$/, // Only punctuation/symbols
      /^(uh|um|ah|er|hmm|eh|oh)+$/i, // Only filler words
      /background/i, // Background noise mentions
      /noise/i, // Noise mentions
      /static/i, // Static mentions
      /silence/i, // Silence mentions
      /unclear/i, // Unclear mentions
      /inaudible/i, // Inaudible mentions
      /muffled/i, // Muffled mentions
      /^[a-z]\s*$/i, // Single letter
      /^\d+$/, // Only numbers
      /^[^\w가-힣]+$/, // Only special characters (no letters/numbers/Korean)
    ];

    for (const pattern of hallucinationPatterns) {
      if (pattern.test(trimmed)) {
        this.logger.debug(`[Quality] Rejected - hallucination pattern: "${trimmed}"`);
        return false;
      }
    }

    // Check if it's mostly punctuation or numbers (likely not real speech)
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    if (wordCount === 0) {
      this.logger.debug(`[Quality] Rejected - no words: "${trimmed}"`);
      return false;
    }

    // Reject single-word transcriptions that are too short (likely noise)
    if (wordCount === 1 && trimmed.length < 4) {
      this.logger.debug(`[Quality] Rejected - single short word (likely noise): "${trimmed}"`);
      return false;
    }

    // Check for too many repeated characters (likely noise)
    const repeatedCharPattern = /(.)\1{3,}/; // Same character 4+ times (reduced from 5)
    if (repeatedCharPattern.test(trimmed)) {
      this.logger.debug(`[Quality] Rejected - repeated characters: "${trimmed}"`);
      return false;
    }

    // Check if it's mostly special characters (stricter threshold)
    const alphaNumericCount = (trimmed.match(/[a-zA-Z0-9가-힣]/g) || []).length;
    const totalChars = trimmed.length;
    if (totalChars > 0 && alphaNumericCount / totalChars < 0.6) { // Increased from 0.5 to 0.6
      this.logger.debug(`[Quality] Rejected - too many special chars: "${trimmed}"`);
      return false;
    }

    // Check for suspicious patterns that indicate background noise or hallucinations
    // Words that don't make sense in context
    const suspiciousWords = ['background', 'noise', 'static', 'silence', 'unclear', 'inaudible', 'muffled'];
    const lowerText = trimmed.toLowerCase();
    for (const word of suspiciousWords) {
      if (lowerText.includes(word)) {
        this.logger.debug(`[Quality] Rejected - contains suspicious word: "${trimmed}"`);
        return false;
      }
    }

    // Check for too many filler words relative to content words
    const fillerWords = ['uh', 'um', 'ah', 'er', 'hmm', 'eh', 'oh', 'like', 'you know'];
    const fillerCount = words.filter(w => fillerWords.includes(w.toLowerCase())).length;
    if (wordCount > 0 && fillerCount / wordCount > 0.5) {
      this.logger.debug(`[Quality] Rejected - too many filler words: "${trimmed}"`);
      return false;
    }

    this.logger.debug(`[Quality] ✅ Accepted: "${trimmed}"`);
    return true;
  }

  /**
   * Validate audio file format
   * @param audioFile - Audio file buffer
   * @returns True if valid
   */
  validateAudioFormat(audioFile: Buffer): boolean {
    // Check file size (max 25MB for Whisper API)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (audioFile.length > maxSize) {
      this.logger.warn(`Audio file too large: ${audioFile.length} bytes`);
      return false;
    }

    // Check minimum size (should have some audio data)
    if (audioFile.length < 1000) {
      this.logger.warn('Audio file too small');
      return false;
    }

    return true;
  }
}


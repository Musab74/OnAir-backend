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
  // ONLY English and Korean supported - strict language restriction
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
        Authorization: `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'multipart/form-data',
      },
      timeout: 30880, // 30 seconds timeout
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
      this.logger.log(
        `Starting transcription${language ? ` for language: ${language}` : ' (auto-detect)'}`,
      );

      const formData = new FormData();

      // Handle both Buffer and file path
      if (typeof audioFile === 'string') {
        // File path
        formData.append('file', fs.createReadStream(audioFile));
      } else {
        // Buffer - determine format from mimetype or default to webm
        // OpenAI Whisper supports: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
        const formatMap: Record<string, { ext: string; contentType: string }> =
          {
            'audio/webm': { ext: 'webm', contentType: 'audio/webm' },
            'audio/wav': { ext: 'wav', contentType: 'audio/wav' },
            'audio/mpeg': { ext: 'mp3', contentType: 'audio/mpeg' },
            'audio/mp3': { ext: 'mp3', contentType: 'audio/mpeg' },
            'audio/mp4': { ext: 'm4a', contentType: 'audio/mp4' },
            'audio/m4a': { ext: 'm4a', contentType: 'audio/mp4' },
            'audio/ogg': { ext: 'ogg', contentType: 'audio/ogg' },
            'audio/flac': { ext: 'flac', contentType: 'audio/flac' },
          };

        const format =
          mimetype && formatMap[mimetype]
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
        fileSize:
          typeof audioFile === 'string' ? 'file path' : audioFile.length,
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

      this.logger.log(
        `Transcription completed: ${result.text.substring(0, 50)}... (detected language: ${detectedLanguage})`,
      );
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

      this.logger.error(
        `[OpenAI] Transcription failed: ${errorDetails}`,
        error.stack,
      );
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
    // Declare variables outside try block so they're accessible in catch
    let normalizedSource = (sourceLanguage || 'en').toLowerCase().trim();
    let normalizedTarget = targetLanguage.toLowerCase().trim();
    
    try {
      // Validate input text
      const trimmedText = text?.trim() || '';
      if (!trimmedText || trimmedText.length < 2) {
        this.logger.warn(
          `Skipping translation - text is empty or too short: "${trimmedText}"`,
        );
        return {
          translatedText: '',
          sourceLanguage: sourceLanguage || 'en',
          targetLanguage,
        };
      }

      // STRICT: Only English and Korean supported
      normalizedSource = (sourceLanguage || 'en').toLowerCase().trim();
      normalizedTarget = targetLanguage.toLowerCase().trim();

      // Map common variations
      if (normalizedSource === 'english' || normalizedSource === 'eng')
        normalizedSource = 'en';
      if (normalizedSource === 'korean' || normalizedSource === 'kor')
        normalizedSource = 'ko';
      if (normalizedTarget === 'english' || normalizedTarget === 'eng')
        normalizedTarget = 'en';
      if (normalizedTarget === 'korean' || normalizedTarget === 'kor')
        normalizedTarget = 'ko';

      // Validate languages - only accept 'en' or 'ko'
      if (normalizedSource !== 'en' && normalizedSource !== 'ko') {
        this.logger.warn(
          `[translateText] Invalid source language: ${sourceLanguage}, defaulting to 'en'`,
        );
        normalizedSource = 'en';
      }
      if (normalizedTarget !== 'en' && normalizedTarget !== 'ko') {
        this.logger.warn(
          `[translateText] Invalid target language: ${targetLanguage}, defaulting to 'en'`,
        );
        normalizedTarget = 'en';
      }

      // If same language, return original text
      if (normalizedSource === normalizedTarget) {
        return {
          translatedText: trimmedText,
          sourceLanguage: normalizedSource,
          targetLanguage: normalizedTarget,
        };
      }

      // Reduced logging for production performance (only log errors and important info)
      // this.logger.log(`Translating text to ${targetLanguage}${sourceLanguage ? ` from ${sourceLanguage}` : ''}`, {
      //   textLength: trimmedText.length,
      //   textPreview: trimmedText.substring(0, 50),
      // });

      // Use OpenAI Chat API for ultra-fast translation
      // Maximum speed optimizations: minimal model, lowest temperature, minimal tokens, shorter timeout
      // For Korean: Use respectful form (존댓말) - always polite
      const isKorean = normalizedTarget === 'ko';
      const languageName = this.getLanguageName(normalizedTarget);

      let systemPrompt: string;
      if (isKorean) {
        systemPrompt = `Translate to Korean using respectful form (존댓말). Use polite endings like -습니다, -세요, -어요, -네요. Always use 존댓말, never 반말. Translation only, no explanations.`;
      } else {
        systemPrompt = `Translate the following text to ${languageName}. Provide only the translation, no explanations or additional text.`;
      }

      const response = await this.axiosInstance.post(
        '/chat/completions',
        {
          model: 'gpt-3.5-turbo', // Fastest and cheapest model for production speed
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
          max_tokens: Math.min(Math.ceil(trimmedText.length * 1.2), 250), // Optimized token limit for speed (translation usually shorter than original)
          stream: false,
          n: 1, // Single response
          top_p: 1, // Default for speed
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 1500, // 1.5 second timeout for faster failure handling in production
        },
      );

      let translatedText =
        response.data.choices[0]?.message?.content?.trim() || trimmedText;

      // Filter vulgar words from translation as well
      if (this.containsVulgarWords(translatedText)) {
        this.logger.error(
          `[Translation] ❌ TRANSLATION REJECTED - contains vulgar words: "${translatedText.substring(0, 50)}"`,
        );
        // Return empty translation instead of vulgar content
        translatedText = '';
      }

      // Check if translation is actually empty (API returned empty or was filtered)
      if (!translatedText || translatedText.trim().length === 0) {
        this.logger.error(
          `[Translation] ❌ TRANSLATION RESULT IS EMPTY for ${targetLanguage}. Original text: "${trimmedText.substring(0, 50)}"`,
        );
        // Don't return empty - return original to prevent silent failure
        // But log it as an error so we know it happened
        return {
          translatedText: trimmedText, // Return original to prevent silent skip
          sourceLanguage: normalizedSource,
          targetLanguage: normalizedTarget,
        };
      }

      const result: TranslationResult = {
        translatedText,
        sourceLanguage: sourceLanguage || 'auto',
        targetLanguage,
      };

      // Reduced logging for production performance
      // this.logger.log(`Translation completed`);
      return result;
    } catch (error: any) {
      // Log error but don't throw - always return something to prevent speech loss
      const errorMsg = error.message || 'Unknown error';
      const isTimeout =
        errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT');

      if (isTimeout) {
        this.logger.error(
          `[Translation] ❌ TIMEOUT for ${targetLanguage} after 1.5s. Text: "${text.substring(0, 50)}"`,
        );
      } else {
        this.logger.error(
          `[Translation] ❌ FAILED for ${targetLanguage}: ${errorMsg}. Text: "${text.substring(0, 50)}"`,
        );
      }

      // Return empty instead of original text - original is wrong language!
      // This will trigger error notification in gateway
      // normalizedSource and normalizedTarget are now in scope (declared outside try block)
      return {
        translatedText: '', // Return empty to trigger error handling
        sourceLanguage: normalizedSource || 'unknown',
        targetLanguage: normalizedTarget,
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
  ): Promise<{
    transcription: TranscriptionResult;
    translation: TranslationResult;
  }> {
    try {
      // First, transcribe the audio
      const transcription = await this.transcribeAudio(
        audioFile,
        undefined,
        mimetype,
      );

      // Validate transcription text - skip if empty or too short
      const trimmedText = transcription.text?.trim() || '';
      const minTextLength = 2; // Minimum characters to consider valid

      if (trimmedText.length < minTextLength) {
        this.logger.debug(
          `Skipping translation - text too short: "${trimmedText}" (${trimmedText.length} chars)`,
        );
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

      // STRICT: Only English and Korean supported
      // Normalize language codes (Whisper returns 'en', 'ko', etc.)
      let sourceLang = (transcription.language || 'en').toLowerCase().trim();
      let normalizedTarget = targetLanguage.toLowerCase().trim();

      // Map common variations to standard codes
      if (sourceLang === 'english' || sourceLang === 'eng') sourceLang = 'en';
      if (sourceLang === 'korean' || sourceLang === 'kor') sourceLang = 'ko';
      if (normalizedTarget === 'english' || normalizedTarget === 'eng')
        normalizedTarget = 'en';
      if (normalizedTarget === 'korean' || normalizedTarget === 'kor')
        normalizedTarget = 'ko';

      // Validate source language - only accept 'en' or 'ko'
      if (sourceLang !== 'en' && sourceLang !== 'ko') {
        this.logger.warn(
          `[transcribeAndTranslate] Unsupported source language: ${sourceLang}, defaulting to 'en'`,
        );
        sourceLang = 'en';
      }

      // Validate target language - only accept 'en' or 'ko'
      if (normalizedTarget !== 'en' && normalizedTarget !== 'ko') {
        this.logger.warn(
          `[transcribeAndTranslate] Unsupported target language: ${normalizedTarget}, defaulting to 'en'`,
        );
        normalizedTarget = 'en';
      }

      const finalSourceLang = sourceLang;
      const finalTargetLang = normalizedTarget;

      // Reduced logging for production performance
      // this.logger.log(`[Translation] Language mapping:`, {
      //   detected: sourceLang,
      //   normalizedSource,
      //   finalSourceLang,
      //   targetLanguage,
      //   normalizedTarget,
      //   finalTargetLang,
      //   willTranslate: finalSourceLang !== finalTargetLang,
      // });

      if (finalSourceLang === finalTargetLang) {
        // Same language - no translation needed
        // this.logger.debug(`Skipping translation - same language: ${finalSourceLang}`);
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

      // Translate the transcribed text to target language (OpenAI GPT supports any language pair)
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
   * @param code - Language code (only 'en' or 'ko' supported)
   * @returns Language name
   */
  private getLanguageName(code: string): string {
    const normalizedCode = code.toLowerCase().trim();
    const lang = this.supportedLanguages.find(
      (l) => l.code.toLowerCase() === normalizedCode,
    );
    if (lang) return lang.name;

    // STRICT: Only English and Korean supported
    // If not in our list, default to English
    this.logger.warn(
      `[getLanguageName] Unsupported language code: ${code}, defaulting to English`,
    );
    return 'English';
  }

  /**
   * Check if text contains vulgar or disrespectful words
   */
  private containsVulgarWords(text: string): boolean {
    const lowerText = text.toLowerCase();

    // Common vulgar/profane words (English)
    const vulgarWords = [
      'fuck',
      'shit',
      'damn',
      'hell',
      'ass',
      'bitch',
      'bastard',
      'crap',
      'piss',
      'dick',
      'cock',
      'pussy',
      'cunt',
      'whore',
      'slut',
      'fag',
      'nigger',
      'nigga',
      'retard',
      'idiot',
      'stupid',
      'dumb',
      'moron',
      'damn',
      'goddamn',
      'bloody',
      'screw',
      'screw you',
      'screw off',
      // Add more as needed
    ];

    // Check for vulgar words
    for (const word of vulgarWords) {
      if (lowerText.includes(word)) {
        this.logger.debug(
          `[Quality] Rejected - contains vulgar word: "${text}"`,
        );
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
    if (trimmed.length < 3) {
      // Minimum 3 characters
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
        this.logger.debug(
          `[Quality] Rejected - hallucination pattern: "${trimmed}"`,
        );
        return false;
      }
    }

    // Check if it's mostly punctuation or numbers (likely not real speech)
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    if (wordCount === 0) {
      this.logger.debug(`[Quality] Rejected - no words: "${trimmed}"`);
      return false;
    }

    // Reject single-word transcriptions that are too short (likely noise)
    if (wordCount === 1 && trimmed.length < 4) {
      this.logger.debug(
        `[Quality] Rejected - single short word (likely noise): "${trimmed}"`,
      );
      return false;
    }

    // Check for too many repeated characters (likely noise)
    const repeatedCharPattern = /(.)\1{3,}/; // Same character 4+ times (reduced from 5)
    if (repeatedCharPattern.test(trimmed)) {
      this.logger.debug(
        `[Quality] Rejected - repeated characters: "${trimmed}"`,
      );
      return false;
    }

    // Check if it's mostly special characters (stricter threshold)
    const alphaNumericCount = (trimmed.match(/[a-zA-Z0-9가-힣]/g) || []).length;
    const totalChars = trimmed.length;
    if (totalChars > 0 && alphaNumericCount / totalChars < 0.6) {
      // Increased from 0.5 to 0.6
      this.logger.debug(
        `[Quality] Rejected - too many special chars: "${trimmed}"`,
      );
      return false;
    }

    // Check for suspicious patterns that indicate background noise or hallucinations
    // Words that don't make sense in context
    const suspiciousWords = [
      'background',
      'noise',
      'static',
      'silence',
      'unclear',
      'inaudible',
      'muffled',
    ];
    const lowerText = trimmed.toLowerCase();
    for (const word of suspiciousWords) {
      if (lowerText.includes(word)) {
        this.logger.debug(
          `[Quality] Rejected - contains suspicious word: "${trimmed}"`,
        );
        return false;
      }
    }

    // Check for too many filler words relative to content words
    const fillerWords = [
      'uh',
      'um',
      'ah',
      'er',
      'hmm',
      'eh',
      'oh',
      'like',
      'you know',
    ];
    const fillerCount = words.filter((w) =>
      fillerWords.includes(w.toLowerCase()),
    ).length;
    if (wordCount > 0 && fillerCount / wordCount > 0.5) {
      this.logger.debug(
        `[Quality] Rejected - too many filler words: "${trimmed}"`,
      );
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

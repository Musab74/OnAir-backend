import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class TranscriptionResultDto {
  @Field()
  text!: string;

  @Field()
  language!: string;

  @Field({ nullable: true })
  duration?: number;
}

@ObjectType()
export class TranslationResultDto {
  @Field()
  originalText!: string;

  @Field()
  translatedText!: string;

  @Field()
  sourceLanguage!: string;

  @Field()
  targetLanguage!: string;
}

@ObjectType()
export class TranscribeResponseDto {
  @Field()
  success!: boolean;

  @Field(() => TranscriptionResultDto)
  data!: TranscriptionResultDto;
}

@ObjectType()
export class TranslateResponseDto {
  @Field()
  success!: boolean;

  @Field(() => TranslationResultDto)
  data!: TranslationResultDto;
}

@ObjectType()
export class TranscribeAndTranslateResponseDto {
  @Field()
  success!: boolean;

  @Field(() => TranscriptionResultDto)
  transcription!: TranscriptionResultDto;

  @Field(() => TranslationResultDto)
  translation!: TranslationResultDto;
}

@ObjectType()
export class LanguageDto {
  @Field()
  code!: string;

  @Field()
  name!: string;
}

@ObjectType()
export class LanguagesResponseDto {
  @Field()
  success!: boolean;

  @Field(() => [LanguageDto])
  languages!: LanguageDto[];
}

@ObjectType()
export class SubtitleDataDto {
  @Field()
  meetingId!: string;

  @Field()
  participantId!: string;

  @Field()
  originalText!: string;

  @Field()
  translatedText!: string;

  @Field()
  sourceLanguage!: string;

  @Field()
  targetLanguage!: string;

  @Field()
  timestamp!: number;
}


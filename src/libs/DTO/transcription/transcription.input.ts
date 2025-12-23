import {
  IsOptional,
  IsString,
  IsMongoId,
  MaxLength,
} from 'class-validator';
import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class TranscribeInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string; // Optional language code (e.g., 'en', 'ko')

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  targetLanguage?: string; // Target language for translation
}

@InputType()
export class TranslateInput {
  @Field()
  @IsString()
  @MaxLength(5000)
  text!: string;

  @Field()
  @IsString()
  @MaxLength(10)
  targetLanguage!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  sourceLanguage?: string;
}

@InputType()
export class TranscribeAndTranslateInput {
  @Field()
  @IsString()
  @MaxLength(10)
  targetLanguage!: string;

  @Field()
  @IsMongoId()
  meetingId!: string;
}

@InputType()
export class SubscribeSubtitlesInput {
  @Field()
  @IsMongoId()
  meetingId!: string;

  @Field()
  @IsString()
  @MaxLength(10)
  language!: string;
}

@InputType()
export class UnsubscribeSubtitlesInput {
  @Field()
  @IsMongoId()
  meetingId!: string;
}


import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.middleware.js";
import { jobGapAnalysisJsonSchema, jobGapAnalysisSchema } from "../schemas/analysis.schema.js";
import type { JobGapAnalysis } from "../types/analysis.types.js";
import type { ProcessedResume } from "./resume.service.js";

type GeminiFile = {
  name?: string;
  uri?: string;
  mimeType?: string;
  mime_type?: string;
  state?: string;
};

type GeminiInteraction = {
  output_text?: string;
  outputText?: string;
};

type GeminiClient = {
  files?: {
    upload(args: unknown): Promise<GeminiFile>;
    get(args: unknown): Promise<GeminiFile>;
    delete?(args: unknown): Promise<void>;
  };
  interactions?: {
    create(args: unknown, options?: unknown): Promise<GeminiInteraction>;
  };
  models?: {
    generateContent(args: unknown): Promise<{ text?: string; output_text?: string }>;
  };
};

const GEMINI_ANALYSIS_TIMEOUT_MS = 90000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, code: string, message: string): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new AppError(code, message, 503));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export interface GeminiAnalysisInput {
  resume: ProcessedResume;
  jobDescription: string;
  jobTitle?: string;
  company?: string;
}

export interface GeminiServiceContract {
  generateAnalysis(input: GeminiAnalysisInput): Promise<JobGapAnalysis>;
}

const SYSTEM_INSTRUCTION = `You are an expert technical recruiter and resume analyst. Compare the provided resume ONLY against the provided job description. Do not invent qualifications that are not explicitly or reasonably supported by the resume. Do not assume the applicant has a skill merely because a related technology appears. Identify exact matches, partial matches, and genuine gaps. Return constructive, specific recommendations. The compatibility score is an estimate, not a hiring prediction.

Evaluate only job-related qualifications, including technical skills, explicitly relevant soft skills, required qualifications, preferred qualifications, years and type of experience, education requirements, tools and technologies, relevant projects, certifications, and job-description keywords.

Do not make decisions or recommendations based on protected or irrelevant characteristics, including race, ethnicity, gender, age, religion, disability, sexual orientation, or national origin.

Scoring guidance: required skills 35%, relevant experience 25%, preferred skills 15%, education/certifications 10%, relevant projects/accomplishments 10%, and job-specific keyword alignment 5%. Treat these as rough guidelines, not probabilities. Never describe the score as a chance of getting hired; describe it as estimated resume-to-job compatibility.`;

const buildPrompt = (input: GeminiAnalysisInput): string => {
  const resumeContent =
    input.resume.type === "text"
      ? `Resume text extracted from the uploaded ${input.resume.sourceType.toUpperCase()} file:\n\n${input.resume.text}`
      : "The resume is attached as a PDF document. Analyze the attached PDF directly.";

  return `Analyze this candidate resume against this job description and return only JSON matching the provided schema.

Job title: ${input.jobTitle ?? "Not provided"}
Company: ${input.company ?? "Not provided"}

Job description:
${input.jobDescription}

${resumeContent}

Important output requirements:
- matchScore must be an integer from 0 to 100.
- The score means estimated resume-to-job compatibility only.
- Use empty arrays when no items are found.
- Base every match and gap on evidence in the resume and requirements in the job description.
- Keep recommendations specific and actionable.`;
};

const getOutputText = (interaction: GeminiInteraction | { text?: string; output_text?: string }): string => {
  if (typeof interaction.output_text === "string") {
    return interaction.output_text;
  }

  if ("outputText" in interaction && typeof interaction.outputText === "string") {
    return interaction.outputText;
  }

  if ("text" in interaction && typeof interaction.text === "string") {
    return interaction.text;
  }

  throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an empty analysis response.", 502);
};

const parseGeminiJson = (text: string): JobGapAnalysis => {
  try {
    const parsed = JSON.parse(text);
    return jobGapAnalysisSchema.parse(parsed);
  } catch {
    throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid analysis format.", 502);
  }
};

const getGeminiStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const maybeStatus = "status" in error ? (error as { status?: unknown }).status : undefined;
  return typeof maybeStatus === "number" ? maybeStatus : undefined;
};

export class GeminiService implements GeminiServiceContract {
  private client?: GeminiClient;

  async generateAnalysis(input: GeminiAnalysisInput): Promise<JobGapAnalysis> {
    let uploadedPdf: GeminiFile | undefined;

    try {
      const client = this.getClient();
      const prompt = buildPrompt(input);

      if (input.resume.type === "pdf") {
        uploadedPdf = await this.uploadPdf(client, input.resume.filePath, input.resume.originalFilename);
      }

      const outputText = await withTimeout(
        client.interactions
          ? this.generateWithInteractions(client, prompt, uploadedPdf)
          : this.generateWithGenerateContent(client, prompt, uploadedPdf),
        GEMINI_ANALYSIS_TIMEOUT_MS,
        "GEMINI_TIMEOUT",
        "Gemini took too long to generate the analysis. Please try again.",
      );

      return parseGeminiJson(outputText);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const status = getGeminiStatus(error);
      if (status === 429) {
        throw new AppError(
          "GEMINI_RATE_LIMITED",
          "Gemini API rate limit or quota was reached. Please try again later.",
          429,
        );
      }

      const statusCode = status && status >= 500 ? 503 : 502;
      throw new AppError("GEMINI_UNAVAILABLE", "Gemini API is unavailable. Please try again later.", statusCode);
    } finally {
      if (uploadedPdf) {
        await this.deleteUploadedFile(uploadedPdf);
      }
    }
  }

  private getClient(): GeminiClient {
    if (!process.env.GEMINI_API_KEY) {
      throw new AppError("GEMINI_NOT_CONFIGURED", "Gemini API key is not configured on the backend.", 500);
    }

    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) as unknown as GeminiClient;
    }

    return this.client;
  }

  private async uploadPdf(client: GeminiClient, filePath: string, displayName: string): Promise<GeminiFile> {
    if (!client.files?.upload) {
      throw new AppError("GEMINI_FILE_UPLOAD_UNSUPPORTED", "Gemini file upload is not available in this SDK version.", 500);
    }

    const uploadedFile = await client.files.upload({
      file: filePath,
      config: {
        displayName,
        mime_type: "application/pdf",
        mimeType: "application/pdf",
      },
    });

    return this.waitForFileProcessing(client, uploadedFile);
  }

  private async waitForFileProcessing(client: GeminiClient, file: GeminiFile): Promise<GeminiFile> {
    if (!file.name || !client.files?.get) {
      return file;
    }

    let currentFile = file;

    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (currentFile.state !== "PROCESSING") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      currentFile = await client.files.get({ name: file.name });
    }

    if (currentFile.state === "PROCESSING") {
      throw new AppError("GEMINI_FILE_PROCESSING_TIMEOUT", "Gemini took too long to process the PDF resume.", 503);
    }

    if (currentFile.state === "FAILED") {
      throw new AppError("GEMINI_FILE_PROCESSING_FAILED", "Gemini could not process the PDF resume.", 502);
    }

    return currentFile;
  }

  private async generateWithInteractions(client: GeminiClient, prompt: string, uploadedPdf?: GeminiFile): Promise<string> {
    if (!client.interactions?.create) {
      throw new AppError("GEMINI_UNAVAILABLE", "Gemini interactions API is unavailable.", 502);
    }

    const input: unknown[] = [{ type: "text", text: prompt }];

    if (uploadedPdf?.uri) {
      input.push({
        type: "document",
        uri: uploadedPdf.uri,
        mime_type: uploadedPdf.mimeType ?? uploadedPdf.mime_type ?? "application/pdf",
      });
    }

    const interaction = await client.interactions.create(
      {
        model: env.GEMINI_MODEL,
        system_instruction: SYSTEM_INSTRUCTION,
        input,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: jobGapAnalysisJsonSchema,
        },
      },
      { timeout: 120000 },
    );

    return getOutputText(interaction);
  }

  private async generateWithGenerateContent(client: GeminiClient, prompt: string, uploadedPdf?: GeminiFile): Promise<string> {
    if (!client.models?.generateContent) {
      throw new AppError("GEMINI_UNAVAILABLE", "Gemini content generation API is unavailable.", 502);
    }

    const parts: unknown[] = [{ text: prompt }];

    if (uploadedPdf?.uri) {
      parts.push({
        fileData: {
          fileUri: uploadedPdf.uri,
          mimeType: uploadedPdf.mimeType ?? uploadedPdf.mime_type ?? "application/pdf",
        },
      });
    }

    const response = await client.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: jobGapAnalysisJsonSchema,
      },
    });

    return getOutputText(response);
  }

  private async deleteUploadedFile(file: GeminiFile): Promise<void> {
    if (!this.client?.files?.delete || !file.name) {
      return;
    }

    try {
      await this.client.files.delete({ name: file.name });
    } catch {
      // The local temp file is still deleted by the request lifecycle.
    }
  }
}

export const geminiService = new GeminiService();

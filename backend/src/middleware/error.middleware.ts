import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { env } from "../config/env.js";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const getMulterError = (err: multer.MulterError): AppError => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return new AppError("FILE_TOO_LARGE", "Resume file must be 5 MB or smaller.", 413);
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return new AppError("INVALID_UPLOAD_FIELD", "Upload the resume using the 'resume' form field.", 400);
  }

  return new AppError("UPLOAD_ERROR", "Unable to process uploaded resume.", 400);
};

const getZodError = (err: ZodError): AppError =>
  new AppError("VALIDATION_ERROR", "Request validation failed.", 400, err.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  })));

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError("NOT_FOUND", "Route not found.", 404));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const isUnexpectedError = !(err instanceof AppError) && !(err instanceof multer.MulterError) && !(err instanceof ZodError);
  const appError =
    err instanceof AppError
      ? err
      : err instanceof multer.MulterError
        ? getMulterError(err)
        : err instanceof ZodError
          ? getZodError(err)
          : new AppError("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", 500);

  const shouldLog = appError.statusCode >= 500 || appError.code === "GEMINI_RATE_LIMITED";

  if (env.NODE_ENV !== "test" && shouldLog) {
    if (isUnexpectedError && err instanceof Error) {
      console.error(`${appError.code}: ${err.name}: ${err.message}\n${err.stack ?? ""}`);
    } else {
      console.error(`${appError.code}: ${appError.message}`);
    }
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details && env.NODE_ENV !== "production" ? { details: appError.details } : {}),
    },
  });
};

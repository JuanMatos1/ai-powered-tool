import express from "express";
import multer from "multer";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 5000);
const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(
        null,
        file.mimetype === "application/pdf" &&
        file.originalname.toLowerCase().endsWith(".pdf")
    );
  },
});

const publicPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "public"
);

const getJobPage = async (value) => {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Job URL must be a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Job URL must use HTTP or HTTPS.");
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "HireLensScanner/1.0",
      accept: "text/html",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
        `The job page returned HTTP ${response.status}.`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    throw new Error(
        "The supplied URL did not return an HTML page."
    );
  }

  return (await response.text()).slice(0, 200_000);
};

app.use(express.static(publicPath));

app.get("/scanner", (_request, response) => {
  response.sendFile(path.join(publicPath, "index.html"));
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post(
    "/scanner",
    upload.single("resume"),
    async (request, response, next) => {
      try {
        if (!process.env.OPENAI_API_KEY) {
          response.status(500).json({
            error: "OPENAI_API_KEY is not configured.",
          });
          return;
        }

        if (!request.file) {
          response.status(400).json({
            error: "Upload a PDF resume using the resume field.",
          });
          return;
        }

        const jobUrl = String(request.body.jobUrl || "").trim();

        if (!jobUrl) {
          response.status(400).json({
            error: "Job URL is required.",
          });
          return;
        }

        const html = await getJobPage(jobUrl);

        const client = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });

        const aiResponse = await client.responses.create({
          model,
          store: false,

          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Compare the attached resume with the job-posting HTML below. Evaluate only the stated skills, experience, education, certifications, and responsibilities. Do not use or infer protected characteristics. This is a resume-to-role alignment analysis, not a hiring recommendation.

JOB POSTING HTML:
${html}`,
                },
                {
                  type: "input_file",
                  filename: request.file.originalname,
                  file_data: `data:application/pdf;base64,${request.file.buffer.toString(
                      "base64"
                  )}`,
                },
              ],
            },
          ],

          text: {
            format: {
              type: "json_schema",
              name: "resume_job_analysis",
              strict: true,

              schema: {
                type: "object",
                additionalProperties: false,

                properties: {
                  score: {
                    type: "integer",
                    minimum: 0,
                    maximum: 100,
                  },

                  summary: {
                    type: "string",
                  },

                  notStrongFitReasons: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                  },

                  resumeSuggestions: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                  },
                },

                required: [
                  "score",
                  "summary",
                  "notStrongFitReasons",
                  "resumeSuggestions",
                ],
              },
            },
          },
        });

        const analysis = JSON.parse(aiResponse.output_text);

        response.json({
          jobUrl,
          analysis,
        });
      } catch (error) {
        next(error);
      }
    }
);

app.use((error, _request, response, _next) => {
  console.error(
      error instanceof Error
          ? error.stack || error.message
          : error
  );

  if (error instanceof multer.MulterError) {
    response.status(400).json({
      error: error.message,
    });
    return;
  }

  const status =
      typeof error?.status === "number"
          ? error.status
          : 502;

  response.status(status).json({
    error:
        error instanceof Error
            ? error.message
            : "Scanner request failed.",
  });
});

app.listen(port, () => {
  console.log(
      `Scanner listening on http://localhost:${port}`
  );
});
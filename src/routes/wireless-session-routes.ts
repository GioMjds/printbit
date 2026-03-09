import path from "node:path";
import type { Express, Request, RequestHandler, Response } from "express";
import type { Server } from "socket.io";
import { adminService } from "../services/admin";
import type { SessionStore } from "../services/session";
import { generateHtmlPreview, supportsHtmlPreview } from "../services/preview";

interface RegisterWirelessSessionRoutesDeps {
  io: Server;
  sessionStore: SessionStore;
  wirelessUploadSingle: RequestHandler;
  resolvePublicBaseUrl: (req: Request) => URL;
  convertToPdfPreview: (sourcePath: string) => Promise<string>;
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

// Only PPT/PPTX still go through LibreOffice; doc/docx use Word COM → PDF
const PDF_CONVERT_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx"]);

export function registerWirelessSessionRoutes(
  app: Express,
  deps: RegisterWirelessSessionRoutesDeps,
) {
  app.get("/api/wireless/sessions", (req: Request, res: Response) => {
    const publicBaseUrl = deps.resolvePublicBaseUrl(req);
    const session = deps.sessionStore.createSession(publicBaseUrl);
    void adminService.appendAdminLog("session_created", "Wireless upload session created.", {
      sessionId: session.sessionId,
    });
    res.status(201).json(session);
  });

  // Specific sub-routes must be registered before "/:sessionId".
  app.get(
    "/api/wireless/sessions/by-token/:token",
    (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSessionByToken(
        req.params.token as string,
        publicBaseUrl,
      );

      if (!session) {
        return res.status(404).json({ error: "Session not found." });
      }

      res.json(session);
    },
  );

  app.get(
    "/api/wireless/sessions/:sessionId/preview",
    async (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSession(
        req.params.sessionId as string,
        publicBaseUrl,
      );

      const requestedFilename = req.query.filename as string;

      const allDocs = 
        session?.documents && session.documents.length > 0
          ? session.documents
          : session?.document
            ? [session.document]
            : [];

      const target = requestedFilename
        ? allDocs.find((doc) => doc.filename === requestedFilename)
        : session?.document ?? allDocs[0];

      if (!target) {
        return requestedFilename
          ? res.status(404).json({ error: "Document not found." })
          : res.status(404).json({ error: "No documents available for preview." });
      }

      const absolutePath = path.resolve(target.filePath);
      const extension = path.extname(absolutePath).toLowerCase();

      try {
        if (extension === ".pdf") {
          res.setHeader("Content-Type", "application/pdf");
          return res.sendFile(absolutePath);
        }

        if (IMAGE_TYPES[extension]) {
          res.setHeader("Content-Type", IMAGE_TYPES[extension]);
          return res.sendFile(absolutePath);
        }

        if (supportsHtmlPreview(extension)) {
          const html = await generateHtmlPreview(absolutePath);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.send(html);
        }

        if (PDF_CONVERT_EXTENSIONS.has(extension)) {
          const pdfPreviewPath = await deps.convertToPdfPreview(absolutePath);
          res.setHeader("Content-Type", "application/pdf");
          return res.sendFile(pdfPreviewPath);
        }

        return res.status(400).json({
          error: `Preview not supported for ${extension}.`,
          code: "UNSUPPORTED_PREVIEW",
        });
      } catch (error) {
        console.error("Preview error:", error);
        const reason =
          error instanceof Error ? error.message : "Unknown preview error";
        return res.status(500).json({
          error:
            "Preview conversion failed. Ensure Microsoft Word or LibreOffice is installed and available.",
          reason,
          code: "PREVIEW_CONVERSION_FAILED",
        });
      }
    },
  );

  app.get("/api/wireless/sessions/:sessionId", (req: Request, res: Response) => {
    const publicBaseUrl = deps.resolvePublicBaseUrl(req);
    const session = deps.sessionStore.tryGetSession(
      req.params.sessionId as string,
      publicBaseUrl,
    );

    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    res.json(session);
  });

  app.post(
    "/api/wireless/sessions/:sessionId/upload",
    deps.wirelessUploadSingle,
    async (req: Request, res: Response) => {
      const { sessionId } = req.params as { sessionId: string };
      const token = (req.query.token as string) ?? "";
      const file = req.file;

      if (!file) {
        void adminService.appendAdminLog("upload_failed", "Wireless upload failed: no file provided.", {
          sessionId,
        });
        return res.status(400).json({ code: "no_file", error: "No file provided." });
      }

      deps.io.to(`session:${sessionId}`).emit("UploadStarted", file.originalname);
      void adminService.appendAdminLog("upload_started", "Wireless upload started.", {
        sessionId,
        filename: file.originalname,
        sizeBytes: file.size,
      });

      const result = await deps.sessionStore.storeUpload(sessionId, token, file);

      if (!result.isSuccess || !result.document) {
        deps.io.to(`session:${sessionId}`).emit("UploadFailed");
        await adminService.appendAdminLog("upload_failed", "Wireless upload failed.", {
          sessionId,
          filename: file.originalname,
          errorCode: result.errorCode ?? null,
        });
        return res.status(400).json({
          code: result.errorCode ?? "UPLOAD_FAILED",
          error: result.errorMsg ?? "Upload failed.",
        });
      }

      const doc = result.document;
      deps.io.to(`session:${sessionId}`).emit("UploadCompleted", doc);
      await adminService.appendAdminLog("upload_completed", "Wireless upload completed.", {
        sessionId,
        filename: doc.filename,
        documentId: doc.documentId,
        sizeBytes: doc.sizeBytes,
      });

      res.status(200).json({
        documentId: doc.documentId,
        sessionId: doc.sessionId,
        fileName: doc.filename,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
      });
    },
  );
}

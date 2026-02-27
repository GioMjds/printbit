import type { Express, Request, Response } from "express";
import { requireAdminLocalAccess } from "../middleware/admin-auth";
import type { SessionStore } from "../services/session";

type PageRoute = { route: string; filePath: string };

interface RegisterPageRoutesDeps {
  sessionStore: SessionStore;
  publicPageRoutes: PageRoute[];
  resolvePublicBaseUrl: (req: Request) => URL;
}

export function registerPageRoutes(app: Express, deps: RegisterPageRoutesDeps) {
  app.get("/favicon.ico", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.get("/upload", (req: Request, res: Response) => {
    const session = deps.sessionStore.createSession(deps.resolvePublicBaseUrl(req));
    res.redirect(`/upload/${encodeURIComponent(session.token)}`);
  });

  // Redirect /admin to /admin/dashboard
  app.get("/admin", requireAdminLocalAccess, (_req: Request, res: Response) => {
    res.redirect("/admin/dashboard");
  });

  for (const page of deps.publicPageRoutes) {
    const routeHandlers = page.route.startsWith("/admin/")
      ? [requireAdminLocalAccess]
      : [];

    app.get(page.route, ...routeHandlers, (_req: Request, res: Response) => {
      res.sendFile(page.filePath);
    });
  }
}

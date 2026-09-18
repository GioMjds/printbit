import path from 'node:path';
import fs from 'node:fs';
import type { SessionStore } from '@/services/session';
import { adminService } from '@/services/admin';

export interface UploadPortalServiceDeps {
  portalDir: string;
  portalAssets: Set<string>;
  sessionStore: SessionStore;
}

export class UploadPortalService {
  private readonly portalDir: string;
  private readonly portalAssets: Set<string>;
  private readonly sessionStore: SessionStore;
  private readonly portalTemplate: string;

  constructor(deps: UploadPortalServiceDeps) {
    this.portalDir = deps.portalDir;
    this.portalAssets = deps.portalAssets;
    this.sessionStore = deps.sessionStore;

    const templatePath = path.join(this.portalDir, 'index.html');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Upload portal HTML not found at: ${templatePath}`);
    }
    this.portalTemplate = fs.readFileSync(templatePath, 'utf-8');
  }

  /**
   * Check if a token is valid (maps to a non-expired session).
   */
  isTokenValid(token: string): boolean {
    return this.sessionStore.isTokenValid(token);
  }

  /**
   * Log when an upload page is accessed with an invalid/expired token.
   */
  async logInvalidTokenAccess(tokenPrefix: string): Promise<void> {
    await adminService.appendAdminLog(
      'upload_page_rejected',
      'Upload page hit with invalid/expired token.',
      { tokenPrefix },
    );
  }

  /**
   * Render the upload portal HTML with the token injected.
   */
  renderPortal(token: string): string {
    let template = this.portalTemplate;

    // Inject <base href> so relative asset URLs resolve under /upload/{token}/
    const safeToken = encodeURIComponent(token);
    const assetBase = `/upload/${safeToken}/`;
    template = template.replace('<head>', `<head>\n  <base href="${assetBase}">`);

    // Inject token into the placeholder used by app.ts
    template = template.replace('{{token}}', token.replace(/"/g, '&quot;'));

    // Inject documentConversionEnabled flag
    const pipelineSettings = adminService.getPipelineSettings();
    const documentConversionEnabled =
      typeof pipelineSettings?.documentConversionEnabled === 'boolean'
        ? pipelineSettings.documentConversionEnabled
        : true;
    template = template.replace(
      '{{documentConversionEnabled}}',
      JSON.stringify(documentConversionEnabled),
    );

    return template;
  }

  /**
   * Check if an asset is allowed to be served.
   */
  isAssetAllowed(asset: string): boolean {
    return this.portalAssets.has(asset);
  }

  /**
   * Get the full path to a portal asset.
   */
  getAssetPath(asset: string): string {
    return path.join(this.portalDir, asset);
  }
}

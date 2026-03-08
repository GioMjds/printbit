export interface IPreviewPort {
  generatePreview(filePath: string): Promise<string>;
}

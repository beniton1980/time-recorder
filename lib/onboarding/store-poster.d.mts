export type StorePosterPdfInput = {
  storeName: string;
  qrPngDataUrl: string;
};

export function generateStorePosterPdf(input: StorePosterPdfInput): Promise<Buffer>;

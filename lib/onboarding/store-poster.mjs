import path from "node:path";
import PDFDocument from "pdfkit";

const NOTO_REGULAR = path.join(process.cwd(), "assets", "fonts", "NotoSansJP-Regular.otf");
const NOTO_BOLD = path.join(process.cwd(), "assets", "fonts", "NotoSansJP-Bold.otf");

function qrPngBuffer(dataUrl) {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("INVALID_QR_PNG");
  return Buffer.from(dataUrl.slice(prefix.length), "base64");
}

export async function generateStorePosterPdf({ storeName, qrPngDataUrl }) {
  const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: `${storeName} ONOGAMI勤怠 打刻案内` } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.registerFont("NotoSansJP-Regular", NOTO_REGULAR);
  doc.registerFont("NotoSansJP-Bold", NOTO_BOLD);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 84;
  const centerX = pageWidth / 2;

  doc.font("NotoSansJP-Bold").fontSize(13).fillColor("#5c6b80")
    .text("スタッフのみなさんへ", 42, 44, { width: contentWidth, align: "center" });
  doc.fontSize(25).fillColor("#20334f")
    .text("出勤・休憩・退勤", 42, 69, {
      width: contentWidth,
      align: "center",
      lineGap: 4,
    });
  doc.fontSize(15).fillColor("#355c43")
    .text("スマホのカメラを\nこのQRに向けてください", 42, 112, {
      width: contentWidth,
      align: "center",
      lineGap: 3,
    });
  const qrSize = 255;
  doc.image(qrPngBuffer(qrPngDataUrl), centerX - qrSize / 2, 167, { width: qrSize, height: qrSize });
  doc.font("NotoSansJP-Regular").fontSize(10.5).fillColor("#333333")
    .text(`${storeName} の打刻用QRです。`, 102, 433, {
      width: contentWidth - 120,
      align: "center",
      lineGap: 3,
    });
  const boxX = 55;
  const boxWidth = pageWidth - 110;
  const stepsTop = 490;
  doc.roundedRect(boxX, stepsTop, boxWidth, 105, 10).fillAndStroke("#f7f7f3", "#d8d8d0");

  const steps = [
    ["1", "表示されたリンクを押す"],
    ["2", "店舗名・名前を確認し、出勤・休憩・退勤を選ぶ"],
  ];

  let y = stepsTop + 14;
  for (const [number, title] of steps) {
    doc.circle(boxX + 24, y + 10, 11).fill("#20334f");
    doc.font("NotoSansJP-Bold").fontSize(10).fillColor("#ffffff")
      .text(number, boxX + 18.5, y + 3.5, { width: 11, align: "center" });
    doc.font("NotoSansJP-Bold").fontSize(12).fillColor("#202020")
      .text(title, boxX + 46, y, { width: boxWidth - 64 });
    y += 32;
  }
  doc.font("NotoSansJP-Bold").fontSize(11).fillColor("#355c43")
    .text("「記録しました」が出たら完了です", boxX + 18, stepsTop + 78, { width: boxWidth - 36, align: "center" });

  const helpTop = 610;
  doc.font("NotoSansJP-Bold").fontSize(10.5).fillColor("#526057")
    .text("読み取れないとき", boxX + 18, helpTop, { width: boxWidth - 36 });
  doc.font("NotoSansJP-Regular").fontSize(9.5)
    .text("カメラを少し離し、QR全体を画面に入れてください。\n開けない場合は、LINEのQRコードリーダーも使えます。", boxX + 18, helpTop + 21, {
      width: boxWidth - 36,
      lineGap: 4,
    });
  doc.fontSize(9)
    .text("初回だけ氏名を入力します。打刻にはLINEアカウントが必要です。", boxX + 18, 681, { width: boxWidth - 36 });

  const correctionTop = 716;
  doc.roundedRect(boxX, correctionTop, boxWidth, 57, 10).fillAndStroke("#edf4ee", "#c8d6cb");
  doc.font("NotoSansJP-Bold").fontSize(10.5).fillColor("#20334f")
    .text("打刻を間違えたとき・忘れたとき", boxX + 18, correctionTop + 7, { width: boxWidth - 36 });
  doc.font("NotoSansJP-Regular").fontSize(9).fillColor("#303a33")
    .text("打刻画面の「打刻修正」から修正できます。\n分からない場合は、店舗の管理者に確認してください。", boxX + 18, correctionTop + 25, {
      width: boxWidth - 36,
      lineGap: 2,
    });

  doc.font("NotoSansJP-Regular").fontSize(8.5).fillColor("#6b6b6b")
    .text("ONOGAMI勤怠 ｜ このQRはこの店舗専用です。", 42, 779, { width: contentWidth, align: "center", lineBreak: false });

  doc.end();
  return completed;
}

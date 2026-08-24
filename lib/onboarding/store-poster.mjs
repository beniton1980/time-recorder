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
    .text("出勤・休憩・退勤は\nこのQRからお願いします", 42, 69, {
      width: contentWidth,
      align: "center",
      lineGap: 4,
    });
  doc.font("NotoSansJP-Regular").fontSize(11).fillColor("#333333")
    .text(`${storeName} の打刻用QRです。LINEで読み取って打刻画面を開いてください。`, 62, 145, {
      width: contentWidth - 40,
      align: "center",
    });

  const qrSize = 205;
  doc.image(qrPngBuffer(qrPngDataUrl), centerX - qrSize / 2, 180, { width: qrSize, height: qrSize });

  const boxX = 55;
  const boxWidth = pageWidth - 110;
  const stepsTop = 410;
  doc.roundedRect(boxX, stepsTop, boxWidth, 216, 10).fillAndStroke("#f7f7f3", "#d8d8d0");

  const steps = [
    ["1", "QRを読み取る", "LINEでQRを読み取り、打刻画面を開きます。"],
    ["2", "初回だけ氏名を入力する", "はじめて利用する時だけ、お名前を入力します。"],
    ["3", "その都度、該当するボタンを押す", "出勤 → 出勤　／　休憩に入る → 休憩開始\n休憩から戻る → 休憩終了　／　帰る → 退勤"],
  ];

  let y = stepsTop + 18;
  for (const [number, title, detail] of steps) {
    doc.circle(boxX + 24, y + 10, 11).fill("#20334f");
    doc.font("NotoSansJP-Bold").fontSize(10).fillColor("#ffffff")
      .text(number, boxX + 18.5, y + 3.5, { width: 11, align: "center" });
    doc.font("NotoSansJP-Bold").fontSize(12).fillColor("#202020")
      .text(title, boxX + 46, y, { width: boxWidth - 64 });
    doc.font("NotoSansJP-Regular").fontSize(9.5).fillColor("#4b4b4b")
      .text(detail, boxX + 46, y + 21, { width: boxWidth - 68, lineGap: 3 });
    y += number === "3" ? 78 : 61;
  }

  const helpTop = 646;
  doc.roundedRect(boxX, helpTop, boxWidth, 91, 10).fillAndStroke("#edf4ee", "#c8d6cb");
  doc.font("NotoSansJP-Bold").fontSize(12).fillColor("#20334f")
    .text("打刻を間違えたとき・忘れたとき", boxX + 18, helpTop + 15, { width: boxWidth - 36 });
  doc.font("NotoSansJP-Regular").fontSize(10).fillColor("#303a33")
    .text("打刻画面の「打刻を修正する」から修正できます。\n分からない場合は、店舗の管理者に確認してください。", boxX + 18, helpTop + 39, {
      width: boxWidth - 36,
      lineGap: 4,
    });

  doc.font("NotoSansJP-Regular").fontSize(8.5).fillColor("#6b6b6b")
    .text("このQRはこの店舗専用です。", 42, 763, { width: contentWidth, align: "center" });
  doc.font("NotoSansJP-Bold").fontSize(9).fillColor("#20334f")
    .text("ONOGAMI勤怠", 42, 786, { width: contentWidth, align: "center" });

  doc.end();
  return completed;
}

"use client";

import { FormEvent, useState } from "react";
import styles from "../onboarding.module.css";

type FormState = {
  storeName: string;
  managerLegalName: string;
  contactEmail: string;
  storeAddress: string;
  closingRule: string;
  termsAccepted: boolean;
};

const initial: FormState = {
  storeName: "",
  managerLegalName: "",
  contactEmail: "",
  storeAddress: "",
  closingRule: "month_end",
  termsAccepted: false,
};

export default function OnboardingApplyPage() {
  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId,
          businessName: form.storeName,
          storeName: form.storeName,
          managerLegalName: form.managerLegalName,
          contactEmail: form.contactEmail,
          storeAddress: form.storeAddress,
          timezone: "Asia/Tokyo",
          businessDayStartMinute: 300,
          closingRule: form.closingRule,
          termsAccepted: form.termsAccepted,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          REQUIRED_FIELD_MISSING: "譛ｪ蜈･蜉帙・蠢・磯・岼縺後≠繧翫∪縺吶・,
          INVALID_CONTACT_EMAIL: "繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・,
          TERMS_ACCEPTANCE_REQUIRED: "蛻ｩ逕ｨ譚｡莉ｶ縺ｸ縺ｮ蜷梧э縺悟ｿ・ｦ√〒縺吶・,
        };
        throw new Error(messages[data.code] ?? "逕ｳ隲九ｒ騾∽ｿ｡縺ｧ縺阪∪縺帙ｓ縺ｧ縺励◆縲・);
      }
      setRequestId(data.request.id as string);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "逕ｳ隲九ｒ騾∽ｿ｡縺ｧ縺阪∪縺帙ｓ縺ｧ縺励◆縲・);
    } finally {
      setSubmitting(false);
    }
  }

  if (requestId) {
    return <main className={styles.page}><section className={[styles.shell, styles.center].join(" ")}>
      <p className={styles.brand}>ONOGAMI</p>
      <h1>逕ｳ隲九ｒ蜿励￠莉倥￠縺ｾ縺励◆</h1>
      <p className={styles.success}>蜀・ｮｹ繧貞ｯｩ譟ｻ蠕後・｣邨｡蜈医Γ繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ縺ｸ縺疲｡亥・縺励∪縺吶ら筏隲狗峩蠕後↓蠎苓・繧РR縺御ｽ懈・縺輔ｌ繧九％縺ｨ縺ｯ縺ゅｊ縺ｾ縺帙ｓ縲・/p>
      <p className={styles.help}>蜿嶺ｻ倡分蜿ｷ・嘴requestId}</p>
    </section></main>;
  }

  return <main className={styles.page}><section className={styles.shell}>
    <p className={styles.brand}>ONOGAMI</p>
    <h1>蠎苓・蛻ｩ逕ｨ逕ｳ隲・/h1>
    <p className={styles.lead}>ONOGAMI 蜍､諤縺ｮ髯仙ｮ壽署萓帷沿繧偵＃蛻ｩ逕ｨ縺ｫ縺ｪ繧句ｺ苓・縺ｮ諠・ｱ繧貞・蜉帙＠縺ｦ縺上□縺輔＞縲ら筏隲句・螳ｹ縺ｯONOGAMI蛛ｴ縺ｧ蟇ｩ譟ｻ縺励∵価隱榊ｾ後↓繝｡繝ｼ繝ｫ縺ｧ縺疲｡亥・縺励∪縺吶・/p>
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>蠎苓・蜷・input required maxLength={120} value={form.storeName} onChange={(e)=>update("storeName",e.target.value)} /></label>
      <div className={styles.grid}>
        <label className={styles.field}>邂｡逅・・ｰ丞錐<input required maxLength={120} value={form.managerLegalName} onChange={(e)=>update("managerLegalName",e.target.value)} /><span className={styles.help}>蠕後⊇縺ｩLINE譛ｬ莠ｺ遒ｺ隱阪ｒ陦後≧譁ｹ</span></label>
        <label className={styles.field}>騾｣邨｡蜈医Γ繝ｼ繝ｫ<input required type="email" maxLength={254} value={form.contactEmail} onChange={(e)=>update("contactEmail",e.target.value)} /><span className={styles.help}>邂｡逅・・魚蠕・→譛域ｬ｡繝ｬ繝昴・繝医・蛻晄悄騾∽ｿ｡蜈・/span></label>
      </div>
      <label className={styles.field}>蠎苓・菴乗園<textarea required maxLength={300} rows={3} value={form.storeAddress} onChange={(e)=>update("storeAddress",e.target.value)} /></label>
      <label className={styles.field}>邱繧∵律<select value={form.closingRule} onChange={(e)=>update("closingRule",e.target.value)}><option value="month_end">譛域忰</option><option value="day_15">15譌･</option><option value="day_25">25譌･</option></select></label>
      <label className={styles.check}><input required type="checkbox" checked={form.termsAccepted} onChange={(e)=>update("termsAccepted",e.target.checked)} /><span>蜈･蜉帙＠縺滓ュ蝣ｱ繧貞ｺ苓・逋ｻ骭ｲ縺ｮ蟇ｩ譟ｻ繝ｻ騾｣邨｡繝ｻ繧ｵ繝ｼ繝薙せ謠蝉ｾ帙・縺溘ａ縺ｫ蛻ｩ逕ｨ縺吶ｋ縺薙→縺ｫ蜷梧э縺励∪縺吶・/span></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} type="submit" disabled={submitting}>{submitting ? "騾∽ｿ｡荳ｭ窶ｦ" : "縺薙・蜀・ｮｹ縺ｧ逕ｳ隲・}</button>
    </form>
  </section></main>;
}


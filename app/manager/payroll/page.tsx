import styles from "./payroll.module.css";

const actions = [
  { href: "/manager/payroll/preview", title: "給与を集計する", description: "給与月度を選び、勤怠と登録済み条件から控除前の総支給額を確認します。", action: "給与プレビューを開く", primary: true },
  { href: "/manager/payroll/history", title: "保存済み給与を見る", description: "確定して保存した給与と、その時点の計算内訳・CSVを確認します。", action: "保存履歴を開く", primary: false },
  { href: "/manager/payroll/settings", title: "給与設定を変更する", description: "店舗ルール、他勤務先、時給、通勤手当を登録・改定します。", action: "給与設定を開く", primary: false },
];

export default function PayrollConsolePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>ONOGAMI 給与集計</p><h1>給与コンソール</h1><p className={styles.lead}>給与の集計、保存履歴、設定を目的別に選べます。</p></div>
        <a className={styles.backLink} href="/manager">管理画面へ戻る</a>
      </header>
      <section className={styles.consoleGrid} aria-label="給与メニュー">
        {actions.map((item) => (
          <article className={`${styles.card} ${item.primary ? styles.consolePrimary : ""}`} key={item.href}>
            <h2>{item.title}</h2><p className={styles.help}>{item.description}</p>
            <a className={item.primary ? styles.primaryButton : styles.secondaryButton} href={item.href}>{item.action}</a>
          </article>
        ))}
      </section>
    </main>
  );
}

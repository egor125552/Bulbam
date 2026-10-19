export function formatPresence(status, now = Date.now(), locale = "ru") {
  const isBelarusian = locale === "be";
  if (!status) return isBelarusian ? "Статус невядомы" : "Статус неизвестен";
  if (status.hidden) return isBelarusian ? "Статус схаваны" : "Статус скрыт";
  if (status.online) return isBelarusian ? "У сетцы" : "В сети";
  if (!Number.isFinite(Number(status.lastSeenAt)) || Number(status.lastSeenAt) <= 0) {
    return isBelarusian ? "Статус невядомы" : "Статус неизвестен";
  }
  const delta = Math.max(0, now - status.lastSeenAt);
  if (delta < 60_000) return isBelarusian ? "Апошняя актыўнасць: толькі што" : "Последняя активность: только что";
  const amount = delta < 60 * 60_000 ? Math.floor(delta / 60_000)
    : delta < 24 * 60 * 60_000 ? Math.floor(delta / (60 * 60_000))
      : Math.floor(delta / (24 * 60 * 60_000));
  const unit = delta < 60 * 60_000 ? "minute" : delta < 24 * 60 * 60_000 ? "hour" : "day";
  const text = new Intl.RelativeTimeFormat(isBelarusian ? "be-BY" : "ru-RU", { numeric: "always" }).format(-amount, unit);
  return (isBelarusian ? "Апошняя актыўнасць: " : "Последняя активность: ") + text;
}

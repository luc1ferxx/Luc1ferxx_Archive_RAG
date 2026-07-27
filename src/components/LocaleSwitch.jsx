import { getLocaleMeta, getNextLocale } from "../archiveI18n";

const LocaleSwitch = ({ locale, onLocaleChange, t }) => {
  const nextLocale = getNextLocale(locale);
  const nextLocaleMeta = getLocaleMeta(nextLocale);
  const currentLocaleMeta = getLocaleMeta(locale);

  return (
    <button
      type="button"
      className="archive-locale-switch"
      aria-label={t("locale.switchTo", {
        language: nextLocaleMeta.label,
      })}
      title={t("locale.title")}
      onClick={() => onLocaleChange?.(nextLocale)}
    >
      <span>{currentLocaleMeta.shortLabel}</span>
      <strong>{nextLocaleMeta.shortLabel}</strong>
    </button>
  );
};

export default LocaleSwitch;

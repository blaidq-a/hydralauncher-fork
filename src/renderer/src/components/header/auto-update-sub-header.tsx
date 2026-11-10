import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { SyncIcon } from "@primer/octicons-react";
import { Link } from "../link/link";
import "./auto-update-header.scss";
import type { AppUpdateStatus } from "@types";

export const releasesPageUrl =
  "https://github.com/blaidq-a/hydralauncher-fork/releases/latest";

/**
 * Fork: offers this fork's own releases. A newer build is downloaded and
 * installed with one click; the portable build links to the release page.
 */
export function AutoUpdateSubHeader() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);

  const { t } = useTranslation("header");

  useEffect(() => {
    const unsubscribe = window.electron.onUpdateAvailable(setStatus);

    window.electron
      .getUpdateStatus()
      .then(setStatus)
      .catch(() => undefined);
    window.electron.checkForUpdates().catch(() => undefined);

    return () => {
      unsubscribe();
    };
  }, []);

  const forkUpdate = status?.fork;
  if (!forkUpdate) return null;

  if (!forkUpdate.canInstall) {
    return (
      <header className="auto-update-sub-header">
        <Link
          to={forkUpdate.releaseUrl || releasesPageUrl}
          className="auto-update-sub-header__new-version-link"
        >
          <SyncIcon
            className="auto-update-sub-header__new-version-icon"
            size={12}
          />
          {t("version_available_download", { version: forkUpdate.version })}
        </Link>
      </header>
    );
  }

  const handleClickInstallUpdate = () => {
    setIsInstalling(true);
    window.electron.restartAndInstallUpdate().catch(() => {
      setIsInstalling(false);
    });
  };

  return (
    <header className="auto-update-sub-header">
      <button
        type="button"
        className="auto-update-sub-header__new-version-button"
        onClick={handleClickInstallUpdate}
        disabled={isInstalling}
      >
        <SyncIcon
          className="auto-update-sub-header__new-version-icon"
          size={12}
        />
        {isInstalling
          ? t("update_downloading", { version: forkUpdate.version })
          : t("version_available_install", { version: forkUpdate.version })}
      </button>
    </header>
  );
}

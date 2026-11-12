import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  DashIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  VideoIcon,
  XIcon,
} from "@primer/octicons-react";
import cn from "classnames";

import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from "@shared";

import { NavigationArrows } from "../navigation-arrows/navigation-arrows";
import { TitleBarSearch } from "./title-bar-search";
import "./app-title-bar.scss";
import "./title-bar-search.scss";

const titleBarStyle = {
  "--title-bar-height": `${MAIN_WINDOW_TITLE_BAR_HEIGHT}px`,
} as CSSProperties;

export interface AppTitleBarProps {
  hasActiveSubscription: boolean;
  version: string;
  isWindowMaximized: boolean;
}

/**
 * The main window's only bar: brand and version over the sidebar, back and
 * forward where the pages start, search in the middle, and the window
 * controls each platform needs.
 */
export function AppTitleBar({
  hasActiveSubscription,
  version,
  isWindowMaximized,
}: Readonly<AppTitleBarProps>) {
  const { t } = useTranslation(["header", "sidebar", "bottom_panel"]);

  // Fork: a newer original Hydra release than the one this fork is based on
  // (shown in the bottom panel until upstream removed it in v4.4.1).
  const [upstreamUpdate, setUpstreamUpdate] = useState<{
    version: string;
    releaseUrl: string;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = window.electron.onUpdateAvailable((updateStatus) =>
      setUpstreamUpdate(updateStatus.upstream)
    );
    window.electron
      .getUpdateStatus()
      .then((updateStatus) => setUpstreamUpdate(updateStatus.upstream))
      .catch(() => undefined);

    return () => {
      unsubscribe();
    };
  }, []);

  const { platform, hasNativeWindowDecorations } = window.electron;

  // The system draws the window frame and title on macOS and on Linux with
  // native decorations, so only Hydra's own frame shows the name.
  const hasCustomFrame =
    platform === "win32" ||
    (platform === "linux" && !hasNativeWindowDecorations);
  const hasCustomWindowControls =
    platform === "linux" && !hasNativeWindowDecorations;

  return (
    <header
      className={cn("title-bar", {
        "title-bar--windows": platform === "win32",
        "title-bar--darwin": platform === "darwin",
      })}
      style={titleBarStyle}
    >
      <div className="title-bar__brand">
        {hasCustomFrame && (
          <h4>
            Hydra
            {hasActiveSubscription && (
              <span className="title-bar__cloud-text"> Cloud</span>
            )}
          </h4>
        )}

        {version && (
          <button
            type="button"
            data-open-workwonders-changelog-mini
            className="title-bar__version"
          >
            v{version}
          </button>
        )}

        {upstreamUpdate && (
          <button
            type="button"
            className="title-bar__version title-bar__upstream-update"
            title={t("upstream_version_available_tooltip", {
              ns: "bottom_panel",
            })}
            onClick={() =>
              window.electron.openExternal(upstreamUpdate.releaseUrl)
            }
          >
            {t("upstream_version_available", {
              ns: "bottom_panel",
              version: upstreamUpdate.version,
            })}
          </button>
        )}
      </div>

      <NavigationArrows className="title-bar__navigation" />

      <div className="title-bar__search">
        <TitleBarSearch />
      </div>

      <button
        type="button"
        className="title-bar__big-picture"
        onClick={() => window.electron.openBigPictureWindow()}
      >
        <VideoIcon size={14} />
        {t("big_picture", { ns: "sidebar" })}
      </button>

      {hasCustomWindowControls && (
        <div className="title-bar__window-controls">
          <button
            type="button"
            className="title-bar__window-control"
            onClick={() => window.electron.minimizeMainWindow()}
            title={t("minimize")}
            aria-label={t("minimize")}
          >
            <DashIcon size={16} />
          </button>
          <button
            type="button"
            className="title-bar__window-control"
            onClick={() => window.electron.toggleMaximizeMainWindow()}
            title={isWindowMaximized ? t("restore") : t("maximize")}
            aria-label={isWindowMaximized ? t("restore") : t("maximize")}
          >
            {isWindowMaximized ? (
              <ScreenNormalIcon size={16} />
            ) : (
              <ScreenFullIcon size={16} />
            )}
          </button>
          <button
            type="button"
            className="title-bar__window-control title-bar__window-control--close"
            onClick={() => window.electron.closeMainWindow()}
            title={t("close")}
            aria-label={t("close")}
          >
            <XIcon size={16} />
          </button>
        </div>
      )}
    </header>
  );
}

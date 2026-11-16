import {
  GlobeIcon,
  TrashIcon,
  PlusIcon,
  PackageIcon,
} from "@primer/octicons-react";
import { Button } from "@renderer/components/button/button";
import { useTranslation } from "react-i18next";
import { AddThemeModal, DeleteAllThemesModal } from "../index";
import "./theme-actions.scss";
import { useState } from "react";
import { THEME_WEB_STORE_URL } from "@renderer/constants";
import { useToast } from "@renderer/hooks";
import { logger } from "@renderer/logger";

interface ThemeActionsProps {
  onListUpdated: () => void;
  themesCount: number;
}

export const ThemeActions = ({
  onListUpdated,
  themesCount,
}: ThemeActionsProps) => {
  const { t } = useTranslation("settings");

  const [addThemeModalVisible, setAddThemeModalVisible] = useState(false);
  const [deleteAllThemesModalVisible, setDeleteAllThemesModalVisible] =
    useState(false);

  // Fork: one-click install of the bundled theme pack
  const { showSuccessToast, showErrorToast } = useToast();
  const [installingPack, setInstallingPack] = useState(false);

  const installThemePack = async () => {
    setInstallingPack(true);
    try {
      const count = await window.electron.installBundledThemes();
      showSuccessToast(t("theme_pack_installed", { count }));
      onListUpdated();
    } catch (error) {
      logger.error("Failed to install the bundled themes", error);
      showErrorToast(t("theme_pack_failed"));
    } finally {
      setInstallingPack(false);
    }
  };

  return (
    <>
      <AddThemeModal
        visible={addThemeModalVisible}
        onClose={() => setAddThemeModalVisible(false)}
        onThemeAdded={onListUpdated}
      />

      <DeleteAllThemesModal
        visible={deleteAllThemesModalVisible}
        onClose={() => setDeleteAllThemesModalVisible(false)}
        onThemesDeleted={onListUpdated}
      />

      <div className="settings-appearance__actions">
        <div className="settings-appearance__actions-left">
          <Button
            theme="primary"
            className="settings-appearance__button"
            onClick={() => {
              window.open(THEME_WEB_STORE_URL, "_blank");
            }}
          >
            <GlobeIcon />
            {t("web_store")}
          </Button>

          <Button
            theme="danger"
            className="settings-appearance__button"
            onClick={() => setDeleteAllThemesModalVisible(true)}
            disabled={themesCount < 1}
          >
            <TrashIcon />
            {t("clear_themes")}
          </Button>
        </div>

        <div className="settings-appearance__actions-right">
          <Button
            theme="outline"
            className="settings-appearance__button"
            onClick={installThemePack}
            disabled={installingPack}
          >
            <PackageIcon />
            {t("install_theme_pack")}
          </Button>

          <Button
            theme="outline"
            className="settings-appearance__button"
            onClick={() => setAddThemeModalVisible(true)}
          >
            <PlusIcon />
            {t("create_theme")}
          </Button>
        </div>
      </div>
    </>
  );
};

import { useEffect, useState } from "react";
import { IS_DESKTOP } from "../../constants";
import type { DownloadSource, Game, GameRepack } from "@types";
import {
  applyHosterAvailability,
  fetchHosterAvailability,
  filterDownloadableRepacks,
} from "@shared";
import { orderBy } from "lodash-es";

export type DownloadOptionsEmptyStateReason =
  | "no-configured-sources"
  | "no-download-options";

interface DownloadStateSetters {
  setDownloadOptions: (v: GameRepack[]) => void;
  setLocalDownloadSources: (v: DownloadSource[]) => void;
  setIsCheckingSources: (v: boolean) => void;
  setIsLoading: (v: boolean) => void;
  setEmptyStateReason: (v: DownloadOptionsEmptyStateReason | null) => void;
}

function applyIfNotCancelled(
  signal: { cancelled: boolean },
  apply: () => void
) {
  if (!signal.cancelled) {
    apply();
  }
}

function resetDownloadOptionsState(
  signal: { cancelled: boolean },
  setters: DownloadStateSetters
) {
  applyIfNotCancelled(signal, () => {
    setters.setDownloadOptions([]);
    setters.setLocalDownloadSources([]);
    setters.setIsCheckingSources(true);
    setters.setIsLoading(false);
    setters.setEmptyStateReason(null);
  });
}

function setNoConfiguredSourcesState(
  signal: { cancelled: boolean },
  setters: DownloadStateSetters
) {
  applyIfNotCancelled(signal, () => {
    setters.setLocalDownloadSources([]);
    setters.setDownloadOptions([]);
    setters.setIsCheckingSources(false);
    setters.setIsLoading(false);
    setters.setEmptyStateReason("no-configured-sources");
  });
}

function startRemoteDownloadOptionsLoading(
  signal: { cancelled: boolean },
  setters: DownloadStateSetters
) {
  applyIfNotCancelled(signal, () => {
    setters.setIsCheckingSources(false);
    setters.setIsLoading(true);
  });
}

function setDownloadOptionsSuccessState(
  signal: { cancelled: boolean },
  setters: DownloadStateSetters,
  options: GameRepack[]
) {
  applyIfNotCancelled(signal, () => {
    setters.setDownloadOptions(options);
    setters.setEmptyStateReason(
      options.length === 0 ? "no-download-options" : null
    );
    setters.setIsCheckingSources(false);
    setters.setIsLoading(false);
  });
}

function setNoDownloadOptionsState(
  signal: { cancelled: boolean },
  setters: DownloadStateSetters
) {
  applyIfNotCancelled(signal, () => {
    setters.setDownloadOptions([]);
    setters.setEmptyStateReason("no-download-options");
    setters.setIsCheckingSources(false);
    setters.setIsLoading(false);
  });
}

async function fetchDownloadOptions(
  game: Pick<Game, "objectId" | "shop">,
  signal: { cancelled: boolean },
  setters: DownloadStateSetters
) {
  resetDownloadOptionsState(signal, setters);

  let sortedSources: DownloadSource[] = [];

  try {
    const sources = (await globalThis.window.electron.leveldb.values(
      "downloadSources"
    )) as DownloadSource[];
    sortedSources = orderBy(sources, "createdAt", "desc");

    applyIfNotCancelled(signal, () => {
      setters.setLocalDownloadSources(sortedSources);
    });
  } catch {
    setNoConfiguredSourcesState(signal, setters);
    return;
  }

  if (sortedSources.length === 0) {
    setNoConfiguredSourcesState(signal, setters);
    return;
  }

  startRemoteDownloadOptionsLoading(signal, setters);

  try {
    const endpoint = `/games/${game.shop}/${game.objectId}/download-sources`;

    const response = await globalThis.window.electron.hydraApi.get<
      GameRepack[]
    >(endpoint, {
      params: {
        take: 100,
        skip: 0,
        downloadSourceIds: sortedSources.map((source) => source.id),
      },
      needsAuth: false,
    });
    const options = Array.isArray(response)
      ? filterDownloadableRepacks(response)
      : [];

    setDownloadOptionsSuccessState(signal, setters, options);

    if (signal.cancelled || options.length === 0) {
      return;
    }

    const results = await fetchHosterAvailability(options, (url, data) =>
      globalThis.window.electron.hydraApi.post(url, { data, needsAuth: false })
    );

    if (results.length === 0) return;

    applyIfNotCancelled(signal, () => {
      setters.setDownloadOptions(applyHosterAvailability(options, results));
    });
  } catch {
    setNoDownloadOptionsState(signal, setters);
  }
}

export function useGameDownloadOptions(
  game: Pick<Game, "objectId" | "shop">,
  visible: boolean
) {
  const shouldLoadDownloadOptions =
    visible && IS_DESKTOP && game.shop !== "custom";
  const [downloadOptions, setDownloadOptions] = useState<GameRepack[]>([]);
  const [localDownloadSources, setLocalDownloadSources] = useState<
    DownloadSource[]
  >([]);
  const [isCheckingSources, setIsCheckingSources] = useState(
    shouldLoadDownloadOptions
  );
  const [isLoading, setIsLoading] = useState(shouldLoadDownloadOptions);
  const [emptyStateReason, setEmptyStateReason] =
    useState<DownloadOptionsEmptyStateReason | null>(null);

  useEffect(() => {
    if (!shouldLoadDownloadOptions) {
      setDownloadOptions([]);
      setLocalDownloadSources([]);
      setIsCheckingSources(false);
      setIsLoading(false);
      setEmptyStateReason(null);
      return;
    }

    const signal = { cancelled: false };

    void fetchDownloadOptions(game, signal, {
      setDownloadOptions,
      setLocalDownloadSources,
      setIsCheckingSources,
      setIsLoading,
      setEmptyStateReason,
    });

    return () => {
      signal.cancelled = true;
    };
  }, [game.objectId, game.shop, shouldLoadDownloadOptions]);

  return {
    downloadOptions,
    localDownloadSources,
    isCheckingSources,
    isLoading,
    emptyStateReason,
  };
}

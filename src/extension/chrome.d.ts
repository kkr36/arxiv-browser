declare namespace chrome {
  interface ChromeEvent<TCallback> {
    addListener(callback: TCallback): void;
  }

  namespace action {
    const onClicked: ChromeEvent<(tab: tabs.Tab) => void | Promise<void>>;
  }

  namespace runtime {
    const id: string | undefined;
    const lastError: { message?: string } | undefined;

    function getURL(path: string): string;
    function sendMessage<TMessage, TResponse>(
      message: TMessage,
      callback: (response: TResponse) => void,
    ): void;

    const onMessage: ChromeEvent<
      (
        message: unknown,
        sender: runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void
    >;

    interface MessageSender {
      tab?: tabs.Tab;
    }
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      windowId?: number;
    }

    function update(
      tabId: number,
      updateProperties: { url?: string; active?: boolean },
    ): Promise<Tab>;

    function query(queryInfo: { url?: string | string[] }): Promise<Tab[]>;

    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
  }

  namespace windows {
    function update(
      windowId: number,
      updateInfo: { focused?: boolean },
    ): Promise<unknown>;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    interface StorageArea {
      get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }

    const local: StorageArea;
    const onChanged: ChromeEvent<
      (changes: Record<string, StorageChange>, areaName: "local" | "sync" | "managed" | "session") => void
    >;
  }

  namespace downloads {
    function download(
      options: {
        url: string;
        filename?: string;
        saveAs?: boolean;
      },
      callback?: (downloadId?: number) => void,
    ): void;
  }
}

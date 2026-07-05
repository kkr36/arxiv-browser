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
    }

    function update(
      tabId: number,
      updateProperties: { url?: string },
    ): Promise<Tab>;
  }
}

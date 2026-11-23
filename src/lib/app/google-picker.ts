/**
 * Google's file chooser (Drive Picker) for the Owner. The browser gets its own short-lived token from
 * Google Identity Services for drive.file only, with the same OAuth client as the server connection, so
 * a file picked here becomes readable by the company's Google connection. Selestial's stored
 * authorization never reaches the browser.
 *
 * Needs NEXT_PUBLIC_GOOGLE_CLIENT_ID, NEXT_PUBLIC_GOOGLE_PICKER_API_KEY and
 * NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER at build time. Without them nothing can be added: with the
 * drive.file scope Google lets Selestial use only files picked here (or files it made), so a pasted link
 * alone can never work. The page says the chooser is being set up instead of offering that path. A pasted
 * link is still useful with the chooser: it opens the chooser on that file, for the Owner to confirm.
 */
export type Picked = { id: string; name: string; mimeType: string };

type PickerConfig = { clientId: string; apiKey: string; appId: string };

export function pickerConfig(): PickerConfig | null {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY?.trim();
  const appId = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  return clientId && apiKey && appId ? { clientId, apiKey, appId } : null;
}

/** A Drive file or folder id from a pasted link or id. Null when it does not look like one. */
export function driveIdFrom(input: string): string | null {
  const text = input.trim();
  const fromUrl = /\/(?:folders|d)\/([\w-]{10,})/.exec(text) ?? /[?&]id=([\w-]{10,})/.exec(text);
  const id = fromUrl?.[1] ?? text;
  return /^[\w-]{10,200}$/.test(id) ? id : null;
}

function load(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google's file chooser could not be loaded."));
    document.head.appendChild(script);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function pickFromDrive(options: { folders: boolean; loginHint?: string; fileIds?: string[] }): Promise<Picked[]> {
  const config = pickerConfig();
  if (!config) throw new Error("Choosing files from Google Drive is still being set up by Selestial’s team.");
  await Promise.all([load("https://accounts.google.com/gsi/client"), load("https://apis.google.com/js/api.js")]);
  const w = window as any;
  await new Promise<void>((resolve) => w.gapi.load("picker", { callback: resolve }));
  const token: string = await new Promise((resolve, reject) => {
    const client = w.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      hint: options.loginHint,
      callback: (response: { access_token?: string; error?: string }) => (response.access_token ? resolve(response.access_token) : reject(new Error(response.error ?? "Google did not allow the file chooser."))),
    });
    client.requestAccessToken({ prompt: "" });
  });
  return new Promise((resolve) => {
    const picker = w.google.picker;
    const view = new picker.DocsView(options.folders ? picker.ViewId.FOLDERS : picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(options.folders).setMode(picker.DocsViewMode.LIST);
    // A pasted link: the chooser opens on that file, so picking it grants Selestial access to it.
    if (options.fileIds?.length) view.setFileIds(options.fileIds.join(","));
    new picker.PickerBuilder()
      .setAppId(config.appId)
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(token)
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data: any) => {
        if (data.action === picker.Action.PICKED) resolve((data.docs ?? []).map((doc: any) => ({ id: doc.id, name: doc.name, mimeType: doc.mimeType })));
        else if (data.action === picker.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

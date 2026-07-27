import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLauncherState } from "@/components/providers/launcher-state-provider";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { FolderOpenIcon } from "lucide-react";

interface CrossSaveResult {
  imported: Record<string, unknown>;
  copyPath: string;
  source: { id: string };
  capture: string;
}

export const Save = () => {
  const { settings, setSetting, services, busyAction, lastError, runAction, startService, stopService } = useLauncherState();
  const [result, setResult] = useState<CrossSaveResult | null>(null);
  const capture = services.capture;
  const captureBusy = capture.state === "starting" || capture.state === "stopping";

  const chooseCaptureFolder = async () => {
    const selected = await open({ title: "Cross Save capture folder", directory: true, multiple: false });
    if (typeof selected === "string") setSetting("capturePath", selected);
  };

  const extractAndCopy = async () => {
    const next = await runAction<CrossSaveResult>("extract-cross-save");
    setResult(next);
    await writeText(JSON.stringify(next.imported, null, 2));
  };

  const toggleCapture = () => {
    if (capture.state === "running") void stopService("capture");
    else if (capture.state === "stopped") void startService("capture");
  };

  return (
    <FieldGroup className="max-w-3xl">
      <FieldSet>
        <FieldLegend>Live official profile capture</FieldLegend>
        <FieldDescription>
          Listen on every interface with Wireshark, then extract the latest JOIN_LOBBY_ACK and import it into RevivalSide.
        </FieldDescription>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="capture-folder">Capture Folder</FieldLabel>
            <div className="flex gap-2">
              <Input id="capture-folder" value={settings.capturePath} placeholder="Default captures folder" readOnly />
              <Button variant="secondary" size="lg" onClick={chooseCaptureFolder} disabled={capture.state !== "stopped"}>
                Browse
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="lg" onClick={toggleCapture} disabled={captureBusy || !!busyAction}>
                {captureBusy && <Spinner />}
                <span>{capture.state === "running" ? "Stop Listening" : capture.state === "starting" ? "Starting..." : "Start Listening"}</span>
              </Button>
              <Button size="lg" onClick={() => void extractAndCopy()} disabled={capture.state !== "stopped" || !!busyAction}>
                <Spinner hidden={busyAction !== "extract-cross-save"} />
                <span>{busyAction === "extract-cross-save" ? "Extracting and Importing..." : "Extract and Copy"}</span>
              </Button>
            </div>
            <FieldDescription>
              {capture.state === "running" ? capture.details : "Npcap and Wireshark dumpcap/tshark are required."}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Import options</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch id="switch-imported-save" checked={settings.switchToImportedSave}
              onCheckedChange={(checked) => setSetting("switchToImportedSave", checked)} disabled={!!busyAction} />
            <FieldLabel htmlFor="switch-imported-save">Switch to imported save</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="update-matching-import" checked={settings.updateMatchingImport}
              onCheckedChange={(checked) => setSetting("updateMatchingImport", checked)} disabled={!!busyAction} />
            <FieldLabel htmlFor="update-matching-import">Update matching official import</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="keep-uid" checked={settings.keepOfficialUid}
              onCheckedChange={(checked) => setSetting("keepOfficialUid", checked)} disabled={!!busyAction} />
            <FieldLabel htmlFor="keep-uid">Keep official UID</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="keep-fc" checked={settings.keepOfficialFriendCode}
              onCheckedChange={(checked) => setSetting("keepOfficialFriendCode", checked)} disabled={!!busyAction} />
            <FieldLabel htmlFor="keep-fc">Keep official friend code</FieldLabel>
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Result</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel>{result ? `Imported from ${result.source.id}` : "Idle"}</FieldLabel>
            <FieldDescription>{result?.copyPath ?? lastError ?? "The imported profile and export path will appear here."}</FieldDescription>
            <Textarea className="min-h-56 font-mono" value={result ? JSON.stringify(result.imported, null, 2) : ""} readOnly />
            {result && (
              <Button variant="secondary" size="lg" onClick={() => openPath(result.copyPath)}>
                <FolderOpenIcon /> Open exported users.json
              </Button>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
};

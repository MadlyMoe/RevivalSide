import { useLauncherState } from "@/components/providers/launcher-state-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FieldGroup, Field, FieldSet, FieldDescription, FieldLabel, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { LOBBY_ACK_OPTIONS } from "@/lib/schema";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, type ComponentProps, type FC } from "react";

const localDateTimeValue = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export const GameSettings: FC<ComponentProps<typeof Dialog>> = ({ ...props }) => {
  const {
    snapshot,
    settings,
    setSetting,
    services,
    busyAction,
    lastError,
    saveSettings,
    resetSettings,
    runAction,
  } = useLauncherState();
  const [serverTime, setServerTime] = useState(localDateTimeValue);
  const listenerLocked = services.listener.state !== "stopped";

  const browseForClient = async () => {
    const selected = await open({
      title: "Select CounterSide Assembly-CSharp.dll",
      filters: [{ name: "Assembly-CSharp", extensions: ["dll"] }],
      multiple: false,
    });
    if (typeof selected === "string") await runAction("set-client", { path: selected });
  };

  const freezeClient = async () => {
    const confirmed = await ask(
      "Copy the selected CounterSide install into RevivalSide's frozen archive? Steam updates will not touch the frozen copy.",
      { title: "Freeze CounterSide client", kind: "warning" },
    );
    if (confirmed) await runAction("freeze-client");
  };

  const reset = async () => {
    const confirmed = await ask("Reset every RevivalSide launcher setting to its default?", {
      title: "Reset launcher settings",
      kind: "warning",
    });
    if (confirmed) await resetSettings();
  };

  return (
    <Dialog {...props}>
      <DialogContent className="sm:max-w-4xl" showCloseButton={false}>
        <Tabs className="gap-6" defaultValue="general" orientation="vertical">
          <TabsList variant="clear">
            <TabsTrigger size="xl" value="general">General</TabsTrigger>
            <TabsTrigger size="xl" value="listener">Listener</TabsTrigger>
            <TabsTrigger size="xl" value="advanced">Advanced</TabsTrigger>
          </TabsList>
          <ScrollArea className="h-132 w-full pr-4">
            <TabsContent value="general">
              <FieldSet>
                <FieldLegend>Game client</FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Assembly-CSharp.dll</FieldLabel>
                    <Input value={settings.clientPath} readOnly placeholder="No client selected..." />
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" size="lg" onClick={browseForClient} disabled={!!busyAction || listenerLocked}>
                        Browse
                      </Button>
                      <Button variant="secondary" size="lg" onClick={() => void runAction("detect-client")} disabled={!!busyAction || listenerLocked}>
                        <Spinner hidden={busyAction !== "detect-client"} />
                        Detect
                      </Button>
                      <Button size="lg" onClick={() => void freezeClient()} disabled={!settings.clientPath || !!busyAction || listenerLocked}>
                        <Spinner hidden={busyAction !== "freeze-client"} />
                        Freeze
                      </Button>
                      <Button
                        size="lg"
                        onClick={() => void runAction("launch-client")}
                        disabled={!snapshot?.frozenClientRoot || services.listener.state !== "running" || !!busyAction}
                      >
                        <Spinner hidden={busyAction !== "launch-client"} />
                        Relaunch Frozen
                      </Button>
                    </div>
                    <FieldDescription>{snapshot?.routing.message ?? "Checking client routing..."}</FieldDescription>
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSet>
                <FieldLegend>Tray behavior</FieldLegend>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <Switch
                      id="minimize-to-tray"
                      checked={settings.minimizeToTray}
                      onCheckedChange={(checked) => setSetting("minimizeToTray", checked)}
                    />
                    <FieldLabel htmlFor="minimize-to-tray">Minimize to tray on close while services are running</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Switch
                      id="service-notifications"
                      checked={settings.notifyServiceStops}
                      onCheckedChange={(checked) => setSetting("notifyServiceStops", checked)}
                    />
                    <FieldLabel htmlFor="service-notifications">Notify when a background service stops unexpectedly</FieldLabel>
                  </Field>
                </FieldGroup>
              </FieldSet>
            </TabsContent>

            <TabsContent value="listener">
              <FieldSet>
                <FieldLegend>Listener</FieldLegend>
                <FieldDescription>Port and server behavior changes take effect the next time the listener starts.</FieldDescription>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="tcp-port">TCP</FieldLabel>
                    <Input id="tcp-port" type="number" min={1} max={65535} value={settings.tcpPort}
                      onChange={(event) => setSetting("tcpPort", Number(event.target.value))} disabled={listenerLocked} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="http-port">HTTP</FieldLabel>
                    <Input id="http-port" type="number" min={1} max={65535} value={settings.httpPort}
                      onChange={(event) => setSetting("httpPort", Number(event.target.value))} disabled={listenerLocked} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="wiki-port">Wiki</FieldLabel>
                    <Input id="wiki-port" type="number" min={1} max={65535} value={settings.wikiPort}
                      onChange={(event) => setSetting("wikiPort", Number(event.target.value))} disabled={services.wiki.state !== "stopped"} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="event-date">Event Date</FieldLabel>
                    <Input id="event-date" type="date" value={settings.eventDate}
                      onChange={(event) => setSetting("eventDate", event.target.value)} disabled={listenerLocked} />
                  </Field>
                  <Field>
                    <FieldLabel>Lobby ACK</FieldLabel>
                    <Select value={settings.lobbyAck}
                      onValueChange={(value) => setSetting("lobbyAck", value as typeof settings.lobbyAck)} disabled={listenerLocked}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {LOBBY_ACK_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <FieldGroup>
                  {[
                    ["allowLanAccess", "lan-access", "Allow LAN User Manager access"],
                    ["verboseLogging", "verbose-logs", "Verbose listener logs"],
                    ["replayCapturedGameFlow", "replay-capture", "Replay captured game flow"],
                    ["skipTutorial", "skip-tutorial", "Skip tutorial to win"],
                    ["resetTutorialOnLogin", "reset-tutorial", "Reset tutorial on login"],
                  ].map(([key, id, label]) => (
                    <Field orientation="horizontal" key={key}>
                      <Switch id={id} checked={settings[key as keyof typeof settings] as boolean}
                        onCheckedChange={(checked) => setSetting(key as keyof typeof settings, checked as never)} disabled={listenerLocked} />
                      <FieldLabel htmlFor={id}>{label}</FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            </TabsContent>

            <TabsContent value="advanced">
              <FieldGroup>
                <FieldSet>
                  <FieldLegend>Server time</FieldLegend>
                  <Field>
                    <Input type="datetime-local" value={serverTime} onChange={(event) => setServerTime(event.target.value)} />
                    <div className="flex gap-2">
                      <Button size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("set-server-time", { iso: new Date(serverTime).toISOString() })}>
                        <Spinner hidden={busyAction !== "set-server-time"} /> Set Time
                      </Button>
                      <Button variant="secondary" size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("clear-server-time")}>Clear</Button>
                    </div>
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend>Installed data</FieldLegend>
                  <FieldDescription>{snapshot?.gameplay.description ?? "Checking gameplay assets..."}</FieldDescription>
                  <Field>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("verify-assets")}>
                        <Spinner hidden={busyAction !== "verify-assets"} /> Verify Assets
                      </Button>
                      <Button size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("build-cache")}>
                        <Spinner hidden={busyAction !== "build-cache"} /> Build Cache
                      </Button>
                      <Button variant="secondary" size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("refresh-wiki-cache")}>Rebuild Wiki Images</Button>
                      <Button variant="secondary" size="lg" disabled={!!busyAction}
                        onClick={() => void runAction("refresh-cutscene-cache")}>Refresh Backgrounds</Button>
                    </div>
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend>Dependencies</FieldLegend>
                  <FieldGroup className="gap-2">
                    {Object.entries(snapshot?.dependencies ?? {}).map(([name, dependency]) => (
                      <div key={name} className="grid grid-cols-[7rem_5rem_1fr] gap-2 text-xs">
                        <span className="uppercase tracking-wide">{name}</span>
                        <span className={dependency.available ? "text-green-400" : "text-destructive"}>
                          {dependency.available ? "Ready" : "Missing"}
                        </span>
                        <span className="text-muted-foreground truncate" title={dependency.path}>{dependency.path}</span>
                      </div>
                    ))}
                  </FieldGroup>
                </FieldSet>

                <FieldSet>
                  <FieldLegend>Environment overrides</FieldLegend>
                  <FieldDescription>One KEY=VALUE entry per line. These override listener defaults.</FieldDescription>
                  <Textarea className="min-h-32 font-mono" value={settings.advancedEnvironment}
                    onChange={(event) => setSetting("advancedEnvironment", event.target.value)} disabled={listenerLocked} />
                </FieldSet>

                <FieldSet>
                  <FieldLegend>Launcher settings</FieldLegend>
                  <Field>
                    <div className="flex gap-2">
                      <Button size="lg" onClick={() => void saveSettings()}>Save Settings</Button>
                      <Button variant="secondary" size="lg" onClick={() => void reset()}>Reset Settings</Button>
                    </div>
                    {lastError && <FieldDescription className="text-destructive">{lastError}</FieldDescription>}
                  </Field>
                </FieldSet>
              </FieldGroup>
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

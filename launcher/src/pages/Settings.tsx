import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { useSettings } from "@/components/providers/settings-provider";
import { CLOSE_WINDOW_OPTIONS } from "@/lib/schema";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export const Settings = () => {
  const { settings, setSetting, resetSettings } = useSettings();

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label">Close Window</FieldLegend>
        <RadioGroup
          value={settings.closeWindow}
          onValueChange={(value) => setSetting("closeWindow", value as typeof settings.closeWindow)}
        >
          {CLOSE_WINDOW_OPTIONS.map((option) => (
            <Field key={option} orientation="horizontal">
              <RadioGroupItem id={`close-windows-${option}`} value={option} />
              <FieldLabel htmlFor={`close-windows-${option}`} className="capitalize">
                {option.replace(/_/g, " ")}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Other</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel>Reset</FieldLabel>
            <div className="flex gap-2">
              <Button size="lg" onClick={resetSettings}>
                Reset Settings
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
};

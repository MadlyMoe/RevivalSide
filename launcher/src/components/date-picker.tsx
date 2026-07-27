import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/utils";
import type { ComponentProps, FC } from "react";

type DatePickerProps = Omit<ComponentProps<typeof Calendar>, "mode" | "required" | "selected" | "onSelect"> & {
  type?: "date" | "datetime-local";
  selected?: Date;
  onSelect?: (date: Date | undefined) => void;
};

export const DatePicker: FC<DatePickerProps> = ({ id, type = "date", selected, onSelect, ...props }) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Input id={id} type={type} value={formatDate(selected)} readOnly />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar mode="single" selected={selected} onSelect={onSelect} captionLayout="dropdown" {...props} />
      </PopoverContent>
    </Popover>
  );
};

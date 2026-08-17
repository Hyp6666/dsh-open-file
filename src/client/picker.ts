export interface FilePickerIntake {
  accept(sessionId: string, files: Iterable<File>): void;
}

export class FilePickerController {
  private readonly input: HTMLInputElement;
  private sessionId: string | undefined;

  constructor(
    private readonly intake: FilePickerIntake,
    documentValue: Document = document
  ) {
    this.input = documentValue.createElement("input");
    this.input.type = "file";
    this.input.multiple = true;
    this.input.hidden = true;
    this.input.dataset.dshOpenFilePicker = "";
    this.input.addEventListener("change", this.onChange);
    documentValue.body.append(this.input);
  }

  open(sessionId: string): void {
    this.sessionId = sessionId;
    this.input.value = "";
    this.input.click();
  }

  dispose(): void {
    this.input.removeEventListener("change", this.onChange);
    this.input.remove();
  }

  private readonly onChange = (): void => {
    if (this.sessionId === undefined || this.input.files === null) return;
    this.intake.accept(this.sessionId, this.input.files);
  };
}

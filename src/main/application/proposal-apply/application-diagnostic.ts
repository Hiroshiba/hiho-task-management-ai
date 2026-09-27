type Disposition =
  | { readonly kind: "recorded_only"; readonly recorded_error: unknown; readonly response_error: unknown }
  | { readonly kind: "unrecorded_only"; readonly unrecorded_error: unknown; readonly response_error: unknown }
  | { readonly kind: "recorded_and_unrecorded"; readonly recorded_error: unknown; readonly unrecorded_error: unknown; readonly response_error: unknown };
type Receipt<TDisposition extends Disposition> = Error & { readonly disposition: TDisposition };
type DiagnosticPorts<TEvent, TDisposition extends Disposition, TReceipt extends Receipt<TDisposition>> = {
  readonly parseEvent: (value: unknown) => TEvent;
  readonly diagnostic: (error: unknown, event: TEvent) => void;
  readonly isReceipt: (error: unknown) => error is TReceipt;
  readonly fromError: (error: unknown) => TDisposition;
  readonly combine: (primary: TDisposition, additional: readonly TDisposition[]) => TDisposition;
  readonly recordedDisposition: (recordedError: unknown, responseError: unknown) => TDisposition;
  readonly createReceipt: (disposition: TDisposition) => TReceipt;
};

/** 適用ジャーナル診断を記録し、元エラーの記録状態を保持します。 */
export function recordApplicationDiagnostic<TEvent, TDisposition extends Disposition, TReceipt extends Receipt<TDisposition>>(
  error: unknown,
  fields: object,
  ports: DiagnosticPorts<TEvent, TDisposition, TReceipt>,
): TReceipt {
  try {
    const event = ports.parseEvent({ kind: "application_journal", ...fields });
    ports.diagnostic(error, event);
    return ports.createReceipt(ports.recordedDisposition(
      error,
      ports.isReceipt(error) ? error.disposition.response_error : error,
    ));
  } catch (diagnosticError: unknown) {
    if (ports.isReceipt(diagnosticError)) {
      throw diagnosticError;
    }
    throw ports.createReceipt(ports.combine(
      ports.fromError(error),
      [ports.fromError(diagnosticError)],
    ));
  }
}

type SharedCausePorts<TFields, TDisposition extends Disposition, TReceipt extends Receipt<TDisposition>> = {
  readonly fromError: (error: unknown) => TDisposition;
  readonly isReceipt: (error: unknown) => error is TReceipt;
  readonly reportDiagnostic: (error: unknown, fields: TFields) => TReceipt;
  readonly combine: (primary: TDisposition, additional: readonly TDisposition[]) => TDisposition;
  readonly createReceipt: (disposition: TDisposition) => TReceipt;
};

/** 共有した適用後同期エラーの未記録分だけを診断します。 */
export function reportSharedPostApplyCause<TFields, TDisposition extends Disposition, TReceipt extends Receipt<TDisposition>>(
  error: unknown,
  fields: TFields,
  ports: SharedCausePorts<TFields, TDisposition, TReceipt>,
): TReceipt {
  const disposition = ports.fromError(error);
  if (disposition.kind === "recorded_only" && ports.isReceipt(error)) {
    return error;
  }
  if (disposition.kind === "recorded_and_unrecorded") {
    const unrecordedReceipt = ports.reportDiagnostic(disposition.unrecorded_error, fields);
    return ports.createReceipt(ports.combine(disposition, [unrecordedReceipt.disposition]));
  }
  return ports.reportDiagnostic(
    disposition.kind === "unrecorded_only" ? disposition.unrecorded_error : error,
    fields,
  );
}

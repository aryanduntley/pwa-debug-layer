/**
 * Wire types for the pwa_installability tool — structured installability
 * diagnostics instead of a bare "manifest invalid". Each gap is coded with a
 * severity and a remediation fix, so an AI client can explain exactly why a PWA
 * is or isn't installable and how to fix each problem.
 *
 * Pure type module. The rules engine lives in the extension pwa_installability
 * module.
 */

export type InstallabilityGapCode =
  | 'no_manifest'
  | 'manifest_parse_error'
  | 'no_name'
  | 'no_start_url'
  | 'display_not_app'
  | 'no_192_icon'
  | 'no_512_icon'
  | 'no_maskable_icon'
  | 'not_secure_context'
  | 'no_service_worker';

/** One installability finding. severity 'error' blocks install; 'warning' is recommended. */
export type InstallabilityGap = {
  readonly code: InstallabilityGapCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
};

export type ManifestIconSummary = {
  readonly src: string;
  readonly sizes: string | null;
  readonly type: string | null;
  readonly purpose: string | null;
};

/** Key fields of the parsed web app manifest used by the installability checks. */
export type ManifestSummary = {
  readonly name: string | null;
  readonly shortName: string | null;
  readonly startUrl: string | null;
  readonly scope: string | null;
  readonly display: string | null;
  readonly themeColor: string | null;
  readonly backgroundColor: string | null;
  readonly icons: readonly ManifestIconSummary[];
};

export type InstallabilityResult = {
  /** False when the page world is unreachable. */
  readonly supported: boolean;
  readonly manifestUrl: string | null;
  readonly manifestFound: boolean;
  readonly secureContext: boolean;
  readonly hasServiceWorker: boolean;
  readonly manifest: ManifestSummary | null;
  /** True when there are no error-severity gaps. */
  readonly installable: boolean;
  readonly gaps: readonly InstallabilityGap[];
};

// One policy shared by the driver and model-facing prompt. Native skill reads
// also consume requests; the final two are reserved for submission/correction.
export const MAX_TURN_REQUESTS = 10;
export const FINAL_TURN_REQUESTS = 2;
export const ANALYSIS_TURN_REQUESTS = MAX_TURN_REQUESTS - FINAL_TURN_REQUESTS;

# LIHPS Motion Angle with Asking H-Test v0.3.1

## Use the H-Test module

- Follow **Protocol and mounting** on the H-Test screen. Aspetar's Hamstring Guide specifies supine positioning, restraint of the upper body and contralateral leg, a brace at 0° knee extension, no warm-up, a passive flexibility assessment before the active set, one submaximal practice raise, three scored raises, and pain and insecurity VAS from 0 to 100. The passive assessment happens outside the app. When comparing injured and uninjured legs, the published follow-up protocol tests the uninjured leg first.
- Mount the phone screen-up at the resting position, with its long edge along the shin and its top pointing toward the ankle. Verify that the phone and brace cannot shift or come loose. The operator should be able to see the screen or hear the cues. Enable motion, select the first side and the number of scored repetitions, and tap **Start H-Test** with the leg at rest. Wait for the cue. The live readout shows leg pitch relative to horizontal before zeroing and flexion relative to the starting position after zeroing.
- Do one submaximal raise and return to the original start. A second cue follows a short stillness check. Perform the scored raises consecutively with a return to the start between raises. Three is the default. Other counts are marked as modified protocol.
- Review each repetition and the set summary. Enter both athlete ratings and tap **Save set**. The other side is preselected. Capture it within the same session. Use **New session** before testing another athlete or occasion.
- **Stop capture** ends acquisition and keeps completed repetitions available for review. Switching screens, backgrounding the app or a major orientation gap also ends capture. If there is no scored set to retain, choose **Discard**. Expand a saved set and choose **Delete set** to remove that entry. Export **H-Test CSV** before clearing site data or changing devices. The original four measurement tools and their Records CSV are on their original tabs.

[Original study](https://doi.org/10.1007/s00167-010-1265-3) · [Published follow-up protocol](https://bjsm.bmj.com/content/47/15/953.full)

## Measurement and QC

The app uses the phone's gravity-referenced orientation matrix to compute sagittal pitch, subtracts the resting pitch and extracts maximum excursion. During practice the app checks which gyroscope channel and sign agree with the ascent and descent. When it verifies a usable channel, peak upward speed comes from that channel, using the orientation peak plus a 40 ms allowance for stream alignment. Otherwise the set continues and peak speed is estimated from the fastest reliable 30–65 ms rise in the flexion angle during ascent. Review and CSV identify orientation-derived estimates. For comparisons across sets, check the velocity source because sampling and smoothing can affect the measured peak. Results estimate braced leg motion relative to rest. Pelvic motion, knee motion or mount movement can change the result.

A practice raise can be as small as 10°. A scored raise starts at 10°, must reach 20° and ends within ±6° of the starting position. A raise still active after five seconds is flagged. Both streams are checked for sampling rate and gaps. Below 30 samples/s or with a gap over 100 ms within a repetition, the affected stream is flagged. Velocity is blank if the chosen source cannot support a usable estimate. Set summaries use scored raises with a usable peak speed and no capture QC flags.

The CSV includes peak off-axis tilt and, when a gyro channel is verified, peak combined angular velocity on the other two axes. These are advisory values. Off-axis flags stay in the CSV and do not affect progression or set summaries. The screen shows sagittal measurements and capture-quality messages. These thresholds are engineering heuristics and need field validation.

The app stores results on the device, including summary metrics and QC in the CSV. Safari can evict website data. Export regularly and handle exported ratings and measurements as athlete data.

## Verification

Run `npm test` from the extracted package with Node.js 20 or later. Tests cover the original orientation math, heading-independent sagittal angle through vertical, the stillness checks, practice-based gyro channel/sign verification, 2–5 rep segmentation, QC, and summaries. A simulated-sensor UI test covers left and right sets, practice exclusion, required VAS, saved history, single-set deletion, interrupt/discard and CSV contents. An offline-shell test checks the required assets and deployment-path isolation with simulated browser caches. The UI test uses a simulated DOM and does not verify layout, Safari permissions or real service worker installation.

Before use with athletes, test the final URL on the intended iPhone and brace:

1. Enable access in Safari and from the Home Screen. On a bench, reproduce known planar angles with a rigid fixture and compare signed angle and speed against a reference. Check both mounting setups and a rotation through 90°. Verify practice completion, the reported velocity source and capture at the target speed.
2. Compare peak ROM and angular velocity to a suitable reference such as motion capture. Check repeatability, missed peaks, sampling rate, attachment movement and both legs under clinician supervision.
3. Verify automatic counts and ratings, CSV sharing, app interruption and reload. Once loaded online, open it again with networking off. Also verify the original four modes on the new build and open the old deployment separately.

A browser may vary sensor cadence and latency or suspend data while locked or backgrounded. Very short ballistic peaks can be missed. Measurements and QC have no validated clinical cut-offs and the app provides no return-to-sport decision.

[Device Orientation and Motion specification](https://www.w3.org/TR/orientation-event/)

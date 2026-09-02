# TacCap data-collection grippers

These local assets power the `3D Replay` view for datasets whose
`robot_type` is `bi_taccap_gripper`.

- `left/gripper.urdf` and `right/gripper.urdf` are sanitized, project-local
  copies of the supplied SolidWorks URDF exports.
- Mesh references are relative, so runtime loading never depends on a ROS
  package path or on files outside this repository.
- The viewer normalizes `left_tcp` / `right_tcp` streams to the canonical frame
  `+X forward, +Y left, +Z up`. Recorded poses are treated as canonical TCP by
  default. When the user selects `Tracker → TCP`, the viewer applies the
  measured, side-specific tracker-to-TCP transforms (or valid episode metadata)
  before replay. The viewer then applies the measured `base_link -> link4`
  translation. Both bundled URDFs define link4 with the same canonical X/Y
  orientation. The left link4 STL keeps its SolidWorks `-90°` Z correction on
  the `<visual>` origin only, so it does not rotate the link4 coordinate frame.
- `joint1` is driven from `0` to `28.92°` (`0.5047492196767601 rad`);
  `joint2` mimics it with multiplier `-1`, so both fingers move through the
  same range in opposite directions.

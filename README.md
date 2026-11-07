# anova-oven-rs

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

The CYW43439 Wi-Fi firmware blobs in
[`crates/anova-oven-pico/firmware/`](crates/anova-oven-pico/firmware/) are
Infineon's and are distributed under the
[Permissive Binary License 1.0](crates/anova-oven-pico/firmware/LICENSE-permissive-binary-license-1.0.txt),
not the licenses above.

### Home Assistant app (this fork)

This repository is a fork of
[robdimsdale/anova-oven-rs](https://github.com/robdimsdale/anova-oven-rs)
with a Home Assistant app on top. The app, the dashboard card and their
tests are Copyright (c) 2026 Uros Gruber, under the
[MIT license](ha-app/LICENSE): `ha-app/`, `dist/`, `tests/`, `home/`,
`repository.yaml` and `.github/workflows/ha-app.yml`.

Changes to the server crates (`crates/`) are under the crates' own terms
(MIT OR Apache-2.0), so they can go back upstream.

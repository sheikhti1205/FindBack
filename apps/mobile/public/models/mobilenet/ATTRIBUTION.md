# Bundled model attribution — MobileNet V1 (alpha 0.25, 224×224)

FindBack bundles this TensorFlow.js graph model so category suggestion runs
fully on-device with no network access.

## Artifact

- Model: **MobileNet V1**, depth multiplier **0.25**, input 224×224, 1000-class
  ImageNet classification (the graph output has 1001 logits: a background class
  plus the 1000 ImageNet classes).
- Format: TensorFlow.js `graph-model` (files: `model.json`,
  `group1-shard1of1.bin`).
- Converted by: TensorFlow.js Converter v1.2.10.1.

## Upstream source

- Original author: the TensorFlow team.
- TensorFlow Hub (canonical model id; now redirects to Kaggle):
  `https://tfhub.dev/google/imagenet/mobilenet_v1_025_224/classification/1`
- Downloaded via the Kaggle API for the same public model, TensorFlow.js variant:
  `https://www.kaggle.com/models/google/mobilenet-v1/tfJs/025-224-classification/1`
  (endpoint used by `scripts/fetch-ml-model.mjs`:
  `https://www.kaggle.com/api/v1/models/google/mobilenet-v1/tfJs/025-224-classification/1/download`)
- Architecture reference:
  `https://github.com/tensorflow/models/blob/master/research/slim/nets/mobilenet_v1.md`

## License

Apache License 2.0. MobileNet and the released ImageNet classification
checkpoints, the TensorFlow.js converter, and the loaded inference code
(`@tensorflow/tfjs`, `@tensorflow-models/mobilenet`) are all Apache-2.0.
See `THIRD_PARTY_SOURCES.md` in the repository root.

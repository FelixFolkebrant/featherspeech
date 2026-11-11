//! Whisper-compatible, Slaney-normalized log-mel features for Smart Turn v3.
//! Algorithm reference: Pipecat _whisper_features.py / Transformers WhisperFeatureExtractor.
use rustfft::{FftPlanner, num_complex::Complex};
use std::sync::Arc;

pub struct Mel {
    fft: Arc<dyn rustfft::Fft<f64>>,
    filters: Vec<Vec<(usize, f64)>>,
    window: Vec<f64>,
}
impl Mel {
    pub fn new() -> Self {
        fn hz(m: f64) -> f64 {
            if m < 15.0 {
                m * 200.0 / 3.0
            } else {
                1000.0 * ((m - 15.0) * 6.4_f64.ln() / 27.0).exp()
            }
        }
        let max_mel = 15.0 + 8.0_f64.ln() * 27.0 / 6.4_f64.ln();
        let edges: Vec<_> = (0..82).map(|i| hz(i as f64 / 81.0 * max_mel)).collect();
        let filters = (0..80)
            .map(|m| {
                (0..201)
                    .filter_map(|k| {
                        let f = k as f64 * 40.0;
                        let w = ((f - edges[m]) / (edges[m + 1] - edges[m]))
                            .min((edges[m + 2] - f) / (edges[m + 2] - edges[m + 1]))
                            .max(0.0)
                            * 2.0
                            / (edges[m + 2] - edges[m]);
                        (w > 0.0).then_some((k, w))
                    })
                    .collect()
            })
            .collect();
        Self {
            fft: FftPlanner::new().plan_fft_forward(400),
            filters,
            window: (0..400)
                .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 400.0).cos())
                .collect(),
        }
    }
    pub fn features(&self, audio: &[f32]) -> Vec<f32> {
        let mut x = vec![0_f32; 128000];
        let n = audio.len().min(x.len());
        x[128000 - n..].copy_from_slice(&audio[audio.len() - n..]);
        let mean = (x.iter().map(|v| *v as f64).sum::<f64>() / 128000.0) as f32;
        let var = (x.iter().map(|v| ((*v - mean) as f64).powi(2)).sum::<f64>() / 128000.0) as f32;
        let scale = (var + 1e-7).sqrt();
        x.iter_mut().for_each(|v| *v = (*v - mean) / scale);
        let mut result = vec![0_f32; 80 * 800];
        let mut frame = vec![Complex::new(0.0, 0.0); 400];
        let mut scratch = vec![Complex::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let mut max = f32::NEG_INFINITY;
        for t in 0..800 {
            for (i, v) in frame.iter_mut().enumerate() {
                let pos = t as isize * 160 + i as isize - 200;
                let pos = if pos < 0 {
                    -pos
                } else if pos >= 128000 {
                    255998 - pos
                } else {
                    pos
                };
                *v = Complex::new(x[pos as usize] as f64 * self.window[i], 0.0);
            }
            self.fft.process_with_scratch(&mut frame, &mut scratch);
            for (m, filter) in self.filters.iter().enumerate() {
                let p = filter
                    .iter()
                    .map(|(k, w)| frame[*k].norm_sqr() * w)
                    .sum::<f64>();
                let v = p.max(1e-10).log10() as f32;
                result[m * 800 + t] = v;
                max = max.max(v);
            }
        }
        result
            .iter_mut()
            .for_each(|v| *v = (v.max(max - 8.0) + 4.0) / 4.0);
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_is_finite() {
        let x = Mel::new().features(&[]);
        assert_eq!(x.len(), 64000);
        assert!(x.iter().all(|x| (*x + 1.5).abs() < 1e-5));
    }
    #[test]
    fn keeps_last_eight_seconds() {
        let x: Vec<_> = (0..150000).map(|i| (i as f32 * 0.1).sin()).collect();
        let m = Mel::new();
        assert_eq!(m.features(&x), m.features(&x[22000..]));
    }
}

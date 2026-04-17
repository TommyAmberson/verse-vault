pub struct Prediction {
    pub predicted_r: f32,
    pub actual_pass: bool,
}

pub fn log_loss(predictions: &[Prediction]) -> f64 {
    if predictions.is_empty() {
        return 0.0;
    }
    let eps = 1e-7f64;
    let n = predictions.len() as f64;
    let mut total = 0.0f64;
    for p in predictions {
        let pred = (p.predicted_r as f64).clamp(eps, 1.0 - eps);
        let y = if p.actual_pass { 1.0 } else { 0.0 };
        total += y * pred.ln() + (1.0 - y) * (1.0 - pred).ln();
    }
    -total / n
}

pub fn auc(predictions: &[Prediction]) -> f64 {
    if predictions.is_empty() {
        return 0.5;
    }

    let mut sorted: Vec<_> = predictions.iter().collect();
    sorted.sort_by(|a, b| b.predicted_r.partial_cmp(&a.predicted_r).unwrap());

    let total_pos = sorted.iter().filter(|p| p.actual_pass).count() as f64;
    let total_neg = sorted.iter().filter(|p| !p.actual_pass).count() as f64;

    if total_pos == 0.0 || total_neg == 0.0 {
        return 0.5;
    }

    let mut auc_sum = 0.0f64;
    let mut tp = 0.0f64;

    for p in &sorted {
        if p.actual_pass {
            tp += 1.0;
        } else {
            auc_sum += tp;
        }
    }

    auc_sum / (total_pos * total_neg)
}

pub fn rmse_binned(predictions: &[Prediction]) -> f64 {
    if predictions.is_empty() {
        return 0.0;
    }

    use std::collections::HashMap;

    let mut bins: HashMap<u32, (f64, f64, f64)> = HashMap::new(); // bin -> (sum_pred, sum_actual, count)

    for p in predictions {
        let bin = bin_key(p.predicted_r);
        let entry = bins.entry(bin).or_default();
        entry.0 += p.predicted_r as f64;
        entry.1 += if p.actual_pass { 1.0 } else { 0.0 };
        entry.2 += 1.0;
    }

    let mut weighted_sq_error = 0.0f64;
    let mut total_weight = 0.0f64;

    for (sum_pred, sum_actual, count) in bins.values() {
        let avg_pred = sum_pred / count;
        let avg_actual = sum_actual / count;
        let sq_error = (avg_pred - avg_actual).powi(2);
        weighted_sq_error += count * sq_error;
        total_weight += count;
    }

    if total_weight == 0.0 {
        return 0.0;
    }

    (weighted_sq_error / total_weight).sqrt()
}

fn bin_key(r: f32) -> u32 {
    (r * 20.0) as u32 // 20 bins from 0.0 to 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perfect_predictions_low_log_loss() {
        let preds = vec![
            Prediction {
                predicted_r: 0.99,
                actual_pass: true,
            },
            Prediction {
                predicted_r: 0.01,
                actual_pass: false,
            },
        ];
        let ll = log_loss(&preds);
        assert!(
            ll < 0.05,
            "perfect predictions should have low log loss: {ll}"
        );
    }

    #[test]
    fn random_predictions_higher_log_loss() {
        let preds = vec![
            Prediction {
                predicted_r: 0.5,
                actual_pass: true,
            },
            Prediction {
                predicted_r: 0.5,
                actual_pass: false,
            },
        ];
        let ll = log_loss(&preds);
        assert!(
            ll > 0.5,
            "random predictions should have higher log loss: {ll}"
        );
    }

    #[test]
    fn perfect_auc() {
        let preds = vec![
            Prediction {
                predicted_r: 0.9,
                actual_pass: true,
            },
            Prediction {
                predicted_r: 0.8,
                actual_pass: true,
            },
            Prediction {
                predicted_r: 0.2,
                actual_pass: false,
            },
            Prediction {
                predicted_r: 0.1,
                actual_pass: false,
            },
        ];
        let a = auc(&preds);
        assert!(
            (a - 1.0).abs() < 0.001,
            "perfect ranking should give AUC=1.0: {a}"
        );
    }

    #[test]
    fn random_auc_near_half() {
        let preds = vec![
            Prediction {
                predicted_r: 0.9,
                actual_pass: false,
            },
            Prediction {
                predicted_r: 0.1,
                actual_pass: true,
            },
        ];
        let a = auc(&preds);
        assert!(a < 0.5, "reversed ranking should give AUC<0.5: {a}");
    }
}

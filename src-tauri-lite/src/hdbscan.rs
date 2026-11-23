// ═══════════════════════════════════════════════════════════════════════
// hdbscan.rs — HDBSCAN aus einem Minimalbaum (plans/lite-embedding-map-plan.md)
//
// Der Baum kommt aus embed_map.rs: Kruskal ueber den kNN-Graphen mit
// Mutual-Reachability-Gewichten (Naeherung des vollstaendigen MST; nicht
// verbundene Teile haengen mit sehr grossem Gewicht zusammen). Hier:
// Single-Linkage-Hierarchie → kondensierter Baum (min_cluster_size) →
// Auswahl nach Stabilitaet (EOM, ohne Wurzel) → Labels und Exemplare.
// ═══════════════════════════════════════════════════════════════════════

/// Abstand fuer Kanten zwischen nicht verbundenen Teilen des kNN-Graphen.
pub const DISCONNECTED: f32 = 1e30;

pub struct UnionFind {
    parent: Vec<usize>,
}
impl UnionFind {
    pub fn new(n: usize) -> Self {
        Self { parent: (0..n).collect() }
    }
    pub fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }
    /// Vereinigt die Mengen; false, wenn schon gleich.
    pub fn union(&mut self, a: usize, b: usize) -> bool {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return false;
        }
        self.parent[ra] = rb;
        true
    }
}

/// Minimalbaum (Kruskal) ueber gewichtete Kanten; nicht verbundene Teile
/// werden mit `DISCONNECTED` aneinandergehaengt. Liefert n − 1 Kanten.
pub fn mst(n: usize, mut edges: Vec<(u32, u32, f32)>) -> Vec<(u32, u32, f32)> {
    edges.sort_by(|a, b| a.2.total_cmp(&b.2));
    let mut uf = UnionFind::new(n);
    let mut out = Vec::with_capacity(n.saturating_sub(1));
    for (a, b, w) in edges {
        if uf.union(a as usize, b as usize) {
            out.push((a, b, w));
        }
    }
    for i in 1..n {
        if uf.union(0, i) {
            out.push((0, i as u32, DISCONNECTED));
        }
    }
    out
}

pub struct Clustering {
    /// Pro Punkt Cluster-Id (0.., nach Groesse absteigend) oder −1 (Rauschen).
    pub labels: Vec<i32>,
    /// Pro Punkt: wie fest er zum Cluster gehoert (0..1; Rauschen 0).
    pub strength: Vec<f32>,
}

/// HDBSCAN auf `n` Punkten aus ihrem Minimalbaum.
pub fn cluster(n: usize, mst: &[(u32, u32, f32)], min_cluster_size: usize) -> Clustering {
    let mcs = min_cluster_size.max(2);
    if n < 2 || mst.len() + 1 != n {
        return Clustering { labels: vec![-1; n], strength: vec![0.0; n] };
    }
    // 1. Single-Linkage-Hierarchie: Blaetter 0..n, innere Knoten n..2n-1
    let mut edges = mst.to_vec();
    edges.sort_by(|a, b| a.2.total_cmp(&b.2));
    let total = 2 * n - 1;
    let mut children = vec![(usize::MAX, usize::MAX); total];
    let mut dist = vec![0.0f32; total];
    let mut size = vec![1usize; total];
    let mut uf = UnionFind::new(total);
    for (t, &(a, b, w)) in edges.iter().enumerate() {
        let node = n + t;
        let (ra, rb) = (uf.find(a as usize), uf.find(b as usize));
        children[node] = (ra, rb);
        dist[node] = w;
        size[node] = size[ra] + size[rb];
        uf.parent[ra] = node;
        uf.parent[rb] = node;
    }
    let root = total - 1;
    let lambda_of = |d: f32| if d >= DISCONNECTED { 0.0 } else if d > 0.0 { 1.0 / d } else { f32::MAX };

    let leaves_of = |node: usize, out: &mut Vec<usize>| {
        let mut stack = vec![node];
        while let Some(x) = stack.pop() {
            if x < n {
                out.push(x);
            } else {
                stack.push(children[x].0);
                stack.push(children[x].1);
            }
        }
    };

    // 2. Kondensierter Baum: Cluster-Ids ab 0 (Wurzel = 0)
    let mut cl_parent: Vec<usize> = vec![usize::MAX]; // Eltern-Cluster
    let mut birth: Vec<f32> = vec![0.0];
    let mut point_cluster = vec![0usize; n]; // Cluster, aus dem der Punkt faellt
    let mut point_lambda = vec![0.0f32; n];
    let mut stack = vec![(root, 0usize, 0.0f32)];
    while let Some((node, c, lam_in)) = stack.pop() {
        if node < n {
            // letzter Punkt eines Zweigs: faellt bei der letzten Teilung heraus
            point_cluster[node] = c;
            point_lambda[node] = lam_in;
            continue;
        }
        let lam = lambda_of(dist[node]);
        // Teilungen auf gleicher Distanz sind eine Ebene: alle Teilbaeume, die erst
        // bei genau dieser Distanz zusammenkommen, werden gemeinsam bewertet. Sonst
        // haengt das Ergebnis von der Reihenfolge gleich langer Kanten ab.
        let mut parts = Vec::new();
        let mut open = vec![children[node].0, children[node].1];
        while let Some(x) = open.pop() {
            if x >= n && dist[x] == dist[node] {
                open.push(children[x].0);
                open.push(children[x].1);
            } else {
                parts.push(x);
            }
        }
        let fall = |sub: usize, point_cluster: &mut Vec<usize>, point_lambda: &mut Vec<f32>| {
            let mut pts = Vec::new();
            leaves_of(sub, &mut pts);
            for p in pts {
                point_cluster[p] = c;
                point_lambda[p] = lam;
            }
        };
        let big: Vec<usize> = parts.iter().copied().filter(|&x| size[x] >= mcs).collect();
        for &x in parts.iter().filter(|&&x| size[x] < mcs) {
            fall(x, &mut point_cluster, &mut point_lambda);
        }
        match big.len() {
            0 => {}
            1 => stack.push((big[0], c, lam)),
            _ => {
                for sub in big {
                    let id = cl_parent.len();
                    cl_parent.push(c);
                    birth.push(lam);
                    stack.push((sub, id, lam));
                }
            }
        }
    }
    let nc = cl_parent.len();
    // Lambda, bei dem ein Kind-Cluster abspaltet = Ende des Eltern-Clusters
    let mut stability = vec![0.0f64; nc];
    let finite = |v: f32, cap: f32| if v == f32::MAX { cap } else { v };
    // Obergrenze fuer "nie herausgefallen": groesstes endliches Lambda
    let cap = point_lambda.iter().copied().filter(|v| *v < f32::MAX).fold(0.0f32, f32::max)
        .max(birth.iter().copied().filter(|v| *v < f32::MAX).fold(0.0, f32::max));
    for p in 0..n {
        let c = point_cluster[p];
        stability[c] += (finite(point_lambda[p], cap) - finite(birth[c], cap)).max(0.0) as f64;
    }
    let mut kids: Vec<Vec<usize>> = vec![vec![]; nc];
    for c in 1..nc {
        let pc = cl_parent[c];
        kids[pc].push(c);
    }
    let mut csize = vec![0usize; nc];
    for p in 0..n {
        let mut c = point_cluster[p];
        loop {
            csize[c] += 1;
            if c == 0 {
                break;
            }
            c = cl_parent[c];
        }
    }
    for c in 1..nc {
        let pc = cl_parent[c];
        stability[pc] += ((finite(birth[c], cap) - finite(birth[pc], cap)).max(0.0) as f64) * csize[c] as f64;
    }

    // 3. Auswahl (EOM), Wurzel ausgeschlossen
    let mut selected = vec![true; nc];
    selected[0] = false;
    for c in (1..nc).rev() {
        let sub: f64 = kids[c].iter().map(|&k| stability[k]).sum();
        if !kids[c].is_empty() && sub > stability[c] {
            selected[c] = false;
            stability[c] = sub;
        } else {
            let mut st = kids[c].clone();
            while let Some(k) = st.pop() {
                selected[k] = false;
                st.extend(kids[k].iter().copied());
            }
        }
    }
    // Ohne Unterteilung (nur Wurzel) gibt es keinen Cluster: alles Rauschen.

    // 4. Labels: naechster ausgewaehlter Vorfahr
    let mut raw = vec![-1i64; n];
    for p in 0..n {
        let mut c = point_cluster[p];
        loop {
            if selected[c] {
                raw[p] = c as i64;
                break;
            }
            if c == 0 {
                break;
            }
            c = cl_parent[c];
        }
    }
    // nach Groesse absteigend nummerieren
    let mut count = vec![0usize; nc];
    raw.iter().filter(|&&c| c >= 0).for_each(|&c| count[c as usize] += 1);
    let mut order: Vec<usize> = (0..nc).filter(|&c| count[c] > 0).collect();
    order.sort_by(|&a, &b| count[b].cmp(&count[a]).then(a.cmp(&b)));
    let mut new_id = vec![-1i32; nc];
    order.iter().enumerate().for_each(|(i, &c)| new_id[c] = i as i32);
    // Staerke: Lambda des Punkts relativ zum groessten Lambda im Cluster
    let mut max_l = vec![0.0f32; nc];
    for p in 0..n {
        if raw[p] >= 0 {
            let c = raw[p] as usize;
            max_l[c] = max_l[c].max(finite(point_lambda[p], cap));
        }
    }
    let labels = raw.iter().map(|&c| if c >= 0 { new_id[c as usize] } else { -1 }).collect();
    let strength = (0..n)
        .map(|p| if raw[p] >= 0 { (finite(point_lambda[p], cap) / max_l[raw[p] as usize].max(1e-12)).min(1.0) } else { 0.0 })
        .collect();
    Clustering { labels, strength }
}

/// Rauschpunkte dem naechsten Cluster zuordnen: naechst im Sinne von HDBSCAN,
/// also mit dem kleinsten Engpass (groesste Kante) auf dem Weg durch den
/// Minimalbaum – der Cluster, mit dem der Punkt in der Hierarchie zuerst
/// verschmilzt. Punkte, die nur ueber `DISCONNECTED` erreichbar sind,
/// bleiben −1. Cluster-Punkte behalten ihr Label.
pub fn assign_noise(n: usize, mst: &[(u32, u32, f32)], labels: &[i32]) -> Vec<i32> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    let mut adj: Vec<Vec<(usize, f32)>> = vec![vec![]; n];
    for &(a, b, w) in mst {
        if w < DISCONNECTED {
            adj[a as usize].push((b as usize, w));
            adj[b as usize].push((a as usize, w));
        }
    }
    let mut out: Vec<i32> = labels.iter().copied().take(n).collect();
    out.resize(n, -1);
    let mut best = vec![f32::INFINITY; n];
    // Heap ueber (Engpass, Knoten); f32 als geordnete Bits (alle Werte >= 0).
    let mut heap = BinaryHeap::new();
    for i in 0..n {
        if out[i] >= 0 {
            best[i] = 0.0;
            heap.push(Reverse((0u32, i)));
        }
    }
    let mut done = vec![false; n];
    while let Some(Reverse((bits, i))) = heap.pop() {
        if done[i] {
            continue;
        }
        done[i] = true;
        let cur = f32::from_bits(bits);
        for &(j, w) in &adj[i] {
            let cand = cur.max(w);
            if !done[j] && cand < best[j] {
                best[j] = cand;
                if labels.get(j).copied().unwrap_or(-1) < 0 {
                    out[j] = out[i];
                }
                heap.push(Reverse((cand.max(0.0).to_bits(), j)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Partition als Menge von Punktmengen (unabhaengig von Cluster-Ids).
    fn partition(labels: &[i32]) -> Vec<Vec<usize>> {
        let mut m: std::collections::BTreeMap<i32, Vec<usize>> = Default::default();
        for (i, &l) in labels.iter().enumerate() {
            m.entry(l).or_default().push(i);
        }
        let mut v: Vec<_> = m.into_iter().map(|(l, p)| if l < 0 { p.into_iter().map(|x| x + 1000).collect() } else { p }).collect();
        v.sort();
        v
    }

    #[test]
    fn equal_weight_edges_do_not_depend_on_order() {
        // Zehn Punkte, alle Kanten Gewicht 1: als Kette zweier Fuenfergruppen und als Stern.
        let chain: Vec<(u32, u32, f32)> = (0..9).map(|i| (i, i + 1, 1.0)).collect();
        let star: Vec<(u32, u32, f32)> = (1..10).map(|i| (0, i, 1.0)).collect();
        let a = cluster(10, &chain, 5);
        let b = cluster(10, &star, 5);
        assert_eq!(partition(&a.labels), partition(&b.labels));
        assert!(a.labels.iter().all(|&l| l < 0), "gleiche Distanz ueberall: keine Teilung, {:?}", a.labels);
        // Zwei Fuenfergruppen zuerst, die verbindende Kante zuletzt (gleiches Gewicht)
        let mut late: Vec<(u32, u32, f32)> = (0..4).map(|i| (i, i + 1, 1.0)).chain((5..9).map(|i| (i, i + 1, 1.0))).collect();
        late.push((4, 5, 1.0));
        assert_eq!(partition(&cluster(10, &late, 5).labels), partition(&a.labels), "Brueckenkante zuletzt");
        // Kantenreihenfolge vertauschen aendert nichts
        let mut rev = chain.clone();
        rev.reverse();
        assert_eq!(partition(&cluster(10, &rev, 5).labels), partition(&a.labels));
    }

    #[test]
    fn equal_internal_weights_still_split_at_a_longer_bridge() {
        let mut e: Vec<(u32, u32, f32)> = (0..4).map(|i| (i, i + 1, 1.0)).chain((5..9).map(|i| (i, i + 1, 1.0))).collect();
        e.push((4, 5, 5.0));
        let want = partition(&cluster(10, &e, 3).labels);
        assert_eq!(want, vec![vec![0, 1, 2, 3, 4], vec![5, 6, 7, 8, 9]]);
        e.reverse();
        assert_eq!(partition(&cluster(10, &e, 3).labels), want);
    }

    #[test]
    fn assign_noise_follows_smallest_bottleneck() {
        // 0-1 Cluster A, 4-5 Cluster B; 2 und 3 Rauschen dazwischen.
        // 1 -(0.5)- 2 -(0.9)- 3 -(0.4)- 4 ; 6 nur ueber DISCONNECTED erreichbar.
        let mst = vec![(0, 1, 0.1), (1, 2, 0.5), (2, 3, 0.9), (3, 4, 0.4), (4, 5, 0.1), (5, 6, DISCONNECTED)];
        let labels = vec![0, 0, -1, -1, 1, 1, -1];
        assert_eq!(assign_noise(7, &mst, &labels), vec![0, 0, 0, 1, 1, 1, -1]);
        // ohne Cluster bleibt alles Rauschen
        assert_eq!(assign_noise(3, &[(0, 1, 0.1), (1, 2, 0.2)], &[-1, -1, -1]), vec![-1, -1, -1]);
    }

    fn full_mst(pts: &[(f32, f32)], min_samples: usize) -> Vec<(u32, u32, f32)> {
        let n = pts.len();
        let d = |i: usize, j: usize| ((pts[i].0 - pts[j].0).powi(2) + (pts[i].1 - pts[j].1).powi(2)).sqrt();
        let core: Vec<f32> = (0..n)
            .map(|i| {
                let mut ds: Vec<f32> = (0..n).filter(|&j| j != i).map(|j| d(i, j)).collect();
                ds.sort_by(f32::total_cmp);
                ds[min_samples - 1]
            })
            .collect();
        let mut e = vec![];
        for i in 0..n {
            for j in i + 1..n {
                e.push((i as u32, j as u32, d(i, j).max(core[i]).max(core[j])));
            }
        }
        mst(n, e)
    }

    #[test]
    fn three_blobs_and_noise() {
        let mut pts = vec![];
        let mut s = 12345u64;
        let mut r = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        for (cx, cy) in [(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)] {
            for _ in 0..40 {
                pts.push((cx + r(), cy + r()));
            }
        }
        pts.push((5.0, 5.0)); // Ausreisser
        let m = full_mst(&pts, 5);
        let c = cluster(pts.len(), &m, 10);
        for b in 0..3 {
            let ls: Vec<i32> = c.labels[b * 40..(b + 1) * 40].to_vec();
            assert!(ls.iter().all(|&l| l == ls[0] && l >= 0), "Blob {b}: {ls:?}");
        }
        let ids: std::collections::BTreeSet<i32> = c.labels[..120].iter().copied().collect();
        assert_eq!(ids.len(), 3);
        // Ausreisser: faellt nach der Geburt seines Clusters heraus → Mitglied mit
        // geringer Staerke (wie im Original-HDBSCAN), deutlich unter den Kernpunkten
        let s_out = c.strength[120];
        let median = { let mut v = c.strength[..120].to_vec(); v.sort_by(f32::total_cmp); v[60] };
        assert!(s_out < 0.5 * median, "Ausreisser {s_out} vs Median {median}");
        assert!(c.strength[..120].iter().all(|&s| s > 0.0 && s <= 1.0));
    }

    #[test]
    fn far_point_between_clusters_is_noise() {
        // Punkt faellt aus der Wurzel heraus (bevor sich die Gruppen trennen) → Rauschen
        let mut pts: Vec<(f32, f32)> = (0..20).map(|i| ((i % 5) as f32 * 0.1, (i / 5) as f32 * 0.1)).collect();
        pts.extend((0..20).map(|i| (10.0 + (i % 5) as f32 * 0.1, (i / 5) as f32 * 0.1)));
        pts.push((5.0, 40.0));
        let c = cluster(pts.len(), &full_mst(&pts, 3), 5);
        assert_eq!(c.labels[40], -1);
        assert_ne!(c.labels[0], c.labels[20]);
    }

    #[test]
    fn disconnected_graph_still_gives_tree() {
        let t = mst(4, vec![(0, 1, 1.0), (2, 3, 1.0)]);
        assert_eq!(t.len(), 3);
        assert!(t.iter().any(|e| e.2 == DISCONNECTED));
    }
}

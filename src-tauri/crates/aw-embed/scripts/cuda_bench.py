import sys, time, numpy as np, onnxruntime as ort
model = sys.argv[1]
print("providers:", ort.get_available_providers())
for prov in (["CUDAExecutionProvider"],):
    s = ort.InferenceSession(model, providers=prov)
    print("aktiv:", s.get_providers()[0])
    n = 360
    x = (np.random.randn(n, 160000) * 0.1).astype(np.float32)
    for b in (8, 32, 64):
        s.run(["embedding"], {"inputs": x[:b]})
        t = time.time()
        for i in range(0, n, b):
            xb = x[i:i + b]
            if len(xb) < b: xb = np.pad(xb, ((0, b - len(xb)), (0, 0)))
            s.run(["embedding"], {"inputs": xb})
        dt = time.time() - t
        print(f"batch {b}: {dt*1000/n:.1f} ms/Fenster, Echtzeitfaktor {n*5/dt:.0f}x")

import requests
import numpy as np
import random

# 1. Point DIRECTLY to the file in your other folder
# (The 'r' before the string is a raw string, which handles Windows backslashes perfectly)
npy_path = r"C:\Users\coura\OneDrive\Documents\FaceRecognition\face_recognition\known_faces.npy"
known_faces = np.load(npy_path)

# 2. Log in with a DIFFERENT photo than the one registered
r = requests.post(
    "http://localhost:8000/login_face",
    json={"embedding": known_faces[1].tolist()}
)
print("real face:", r.json())

# 3. Try to break in with random noise
noise = [random.random() for _ in range(128)]
r = requests.post("http://localhost:8000/login_face", json={"embedding": noise})
print("random noise:", r.json())
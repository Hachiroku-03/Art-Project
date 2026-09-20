import requests
import numpy as np

npy_path = r"C:\Users\coura\OneDrive\Documents\FaceRecognition\face_recognition\known_faces.npy"
known_faces = np.load(npy_path)

response = requests.post(
    "http://localhost:8000/register_face",
    json={"username": "victor", "embedding": known_faces[0].tolist()}
)
print(response.json())
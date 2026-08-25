// ART GALLERY PROGRAM

const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks').querySelector('ul');


burger.addEventListener('click', () => {
  navLinks.classList.toggle('show');
  burger.classList.toggle('toggle');
});

const nameInput = document.getElementById("nameInput");
const emailInput = document.getElementById("emailInput");
const extraText = document.getElementById("extraText");
const btn = document.getElementById("btn");
const alert = document.getElementById("alert");

btn.onclick = function(){
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const extra = extraText.value.trim();

  if(name === ""){
       alert.textContent = "Username is required"
  }
  else if(email === ""){
    alert.textContent = "Email is required"
  }
  else if(extra === ""){ 
    alert.textContent = "Art description is required"
  }
  else{
       alert.textContent = `${name} ${email} ${extra}`
  }

};
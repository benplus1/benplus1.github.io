var now = new Date()
var month = new Array("January", 
					  "February", 
					  "March", 
					  "April", 
					  "May", 
					  "June", 
					  "July", 
					  "August", 
					  "September", 
					  "October", 
					  "November", 
					  "December")

document.write(month[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear())

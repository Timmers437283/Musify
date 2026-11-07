const firebaseConfig = {
    apiKey: "AIzaSyCRm-xrA8XNKtDXya0nfMyFQMy54Yrq5bs",
    authDomain: "musify-dev-caaae.firebaseapp.com",
    databaseURL: "https://musify-dev-caaae-default-rtdb.firebaseio.com",
    projectId: "musify-dev-caaae",
    storageBucket: "musify-dev-caaae.firebasestorage.app",
    messagingSenderId: "960169640090",
    appId: "1:960169640090:web:0e0c7e5d1997234f45df23"
};

firebase.initializeApp(firebaseConfig);

window.musifyAuth = firebase.auth();
window.musifyDatabase = firebase.database();

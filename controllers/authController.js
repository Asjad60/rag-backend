const User = require('../models/User');

exports.register = async (req, res) => {
  try {
    const { email, password, name } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: 'User already exists' });
    
    user = new User({ email, password, name }); // Not hashing for simplicity in this demo
    await user.save();
    
    res.status(201).json({ message: 'Registered successfully', userId: user._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    
    res.json({ message: 'Logged in', userId: user._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

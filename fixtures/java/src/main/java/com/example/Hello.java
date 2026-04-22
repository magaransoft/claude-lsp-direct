package com.example;

public class Hello {
    public String greet(String name) {
        return "hello, " + name;
    }

    public static void main(String[] args) {
        Hello h = new Hello();
        System.out.println(h.greet("world"));
    }
}
